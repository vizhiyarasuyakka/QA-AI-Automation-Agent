import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser, Page } from "playwright-core";
import { findControl, follow, grow, settle, stepLabel, type Box, type PageContent, type Step } from "./screencompare";

export type Flow = { name: string; steps: Step[] };

const MAX_FLOWS = 20;
/** A flow is at most two clicks deep: what the screen opens, and what that opens, such as a tab of a detail view. */
const MAX_DEPTH = 2;
/** Clicking through one prototype stops here, keeping what it found. */
const TIME_LIMIT = 180_000;
/**
 * Controls never clicked, in the prototype or on the build: they change or leave data or the session, or only close
 * what is open. A flow is followed to look, never to save.
 */
const NEVER = /\b(delete|remove|archive|discard|save|submit|create|confirm|send|approve|reject|publish|log ?out|sign ?out|import|export|download|upload|pay|deactivate|disable|reset|apply|update|duplicate|clone|merge|convert|close|cancel|back|dismiss)\b/i;

/** Of what one state opens, at most this many are followed further, so the five tabs of a filter do not crowd out the rest. */
const MAX_BRANCHES = 5;

type Control = { role: Exclude<Step["role"], "row">; name: string; nav: boolean; data: boolean };
/**
 * What a person sees of a page: its own words, how many fields it shows, what can be clicked, and the values in the
 * rows of its list, such as names and stages, which are sample data.
 */
type Look = { texts: string[]; fields: number; controls: Control[]; values: string[] };

/**
 * Runs in the page. Words in tables or with numbers in them are sample data and do not tell one state from another.
 * Shown means drawn, not see-through and on top at its middle. A list's rows are its table body's, or the rows marked
 * as rows that share the most common look, as the heading row does not.
 */
const LOOK = String.raw`(() => {
  const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
  const alpha = new Map();
  const opacity = (e) => {
    if (!e || e === document.documentElement) return 1;
    if (!alpha.has(e)) alpha.set(e, (Number(getComputedStyle(e).opacity) || 0) * opacity(e.parentElement));
    return alpha.get(e);
  };
  const shown = (el) => {
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1 || box.right <= 0 || box.left >= innerWidth || box.bottom <= 0 || box.top >= innerHeight) return false;
    if (getComputedStyle(el).visibility === "hidden" || opacity(el) < 0.1) return false;
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return !!hit && (hit === el || el.contains(hit) || hit.contains(el));
  };
  const data = (el) => !!el.closest("tbody, [role=row], [role=gridcell], [role=cell]");
  const texts = [];
  for (const el of document.body ? document.body.querySelectorAll("*") : []) {
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName) || el.closest("svg")) continue;
    let t = "";
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
    t = clean(t);
    if (t && t.length <= 60 && /\p{L}/u.test(t) && !/\d/.test(t) && !data(el) && shown(el)) texts.push(t);
  }
  const fields = [...document.querySelectorAll("input:not([type=hidden]), select, textarea, [role=combobox], [role=textbox], [contenteditable=true]")].filter((e) => !data(e) && shown(e)).length;
  const controls = [];
  for (const el of document.querySelectorAll("button, a[href], [role=button], [role=tab], [role=menuitem], [role=link], input[type=button], input[type=submit]")) {
    if (el.closest("svg") || el.disabled || el.getAttribute("aria-disabled") === "true" || !shown(el)) continue;
    const role = el.getAttribute("role") || (el.tagName === "A" ? "link" : "button");
    if (!/^(button|link|tab|menuitem)$/.test(role)) continue;
    const name = clean(el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("title"));
    if (name && name.length <= 60) controls.push({ role, name, nav: !!el.closest("aside, nav, [role=navigation]"), data: data(el) });
  }
  const marked = [...document.querySelectorAll("[role=row]")].filter((r) => !r.closest("thead") && !r.querySelector("[role=columnheader]"));
  const looks = new Map();
  for (const r of marked) looks.set(r.className, (looks.get(r.className) || 0) + 1);
  const common = [...looks.entries()].sort((a, b) => b[1] - a[1])[0];
  const rows = [...document.querySelectorAll("tbody tr"), ...(common && common[1] >= 2 ? marked.filter((r) => r.className === common[0]) : [])];
  const values = new Set();
  for (const row of rows) for (const el of row.querySelectorAll("*")) {
    let t = "";
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
    t = clean(t).toLowerCase();
    if (t.length >= 3 && t.length <= 60 && /\p{L}/u.test(t)) values.add(t);
  }
  return { texts, fields, controls, values: [...values] };
})()`;

const look = (page: Page) => page.evaluate<Look>(LOOK);
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const said = (l: Look) => `${[...new Set(l.texts)].sort().join("\n")}|${l.fields}`;
const keyOf = (s: Step) => `${s.role}|${s.name.toLowerCase()}`;

/**
 * The flows of an HTML prototype screen, found by clicking each of its controls from the state the screen opens in,
 * and then each control that state added. A click that opens something new to see (at least one more field, or two
 * more of the page's own words, as a two-item menu has) is a flow, once per distinct state. Side bar links lead to other screens and are not
 * followed; in a table, only the first row and the actions every row has are. Nothing that saves, deletes or leaves
 * is clicked.
 */
export async function findFlows(browser: Browser, proto: { bytes: Uint8Array }, width: number): Promise<Flow[]> {
  const started = Date.now();
  const dir = mkdtempSync(path.join(os.tmpdir(), "qa-flows-"));
  const file = path.join(dir, "prototype.html");
  writeFileSync(file, proto.bytes);
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
  const page = await context.newPage();
  const open = async (steps: Step[]) => {
    await page.goto(pathToFileURL(file).href, { waitUntil: "load", timeout: 60_000 });
    await settle(page);
    const at = (await follow(page, steps, true)).missing;
    await grow(page, width);
    return at === null;
  };
  try {
    if (!(await open([]))) return [];
    const base = await look(page);
    const onScreen = new Set(base.controls.map(keyOf));
    // A control named after a record, such as a card titled with an account or a badge showing its stage, is sample data.
    const named = (name: string) => base.values.some((v) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(v)}($|[^\\p{L}\\p{N}])`, "iu").test(name));
    const found: Flow[] = [];
    const seen = new Set([said(base)]);
    // What a state opened, richest first: a form or detail view is explored before a menu.
    const queue: { steps: Step[]; look: Look; worth: number }[] = [{ steps: [], look: base, worth: 0 }];
    while (queue.length && found.length < MAX_FLOWS && Date.now() - started < TIME_LIMIT) {
      const from = queue.shift()!;
      if (from.steps.length && !(await open(from.steps))) continue;
      const words = new Set(from.look.texts);
      // An action nearly every row has, such as a row menu, is clicked on the first row; a value some rows share is data.
      const perRow = new Map<string, number>();
      for (const c of from.look.controls) if (c.data) perRow.set(keyOf(c), (perRow.get(keyOf(c)) ?? 0) + 1);
      const most = Math.max(0, ...perRow.values());
      const candidates = new Map<string, Step>();
      if (!from.steps.length && (await findControl(page, { role: "row", name: "" }))) candidates.set("row", { role: "row", name: "first row" });
      for (const c of from.look.controls) {
        const step: Step = { role: c.role, name: c.name }, key = keyOf(step), rows = perRow.get(key) ?? 0;
        if (c.nav || NEVER.test(c.name) || (c.data && (rows < 2 || rows < most * 0.8)) || (from.steps.length && onScreen.has(key)) || named(c.name)) continue;
        if (!candidates.has(key)) candidates.set(key, step);
      }
      let branches = 0;
      for (const step of candidates.values()) {
        if (found.length >= MAX_FLOWS || Date.now() - started > TIME_LIMIT || (from.steps.length && branches >= MAX_BRANCHES)) break;
        const control = await findControl(page, step);
        if (!control) continue;
        const before = page.url();
        if (!(await control.click({ timeout: 3_000 }).then(() => true, () => false))) continue;
        await page.waitForTimeout(700);
        const left = new URL(page.url()).pathname !== new URL(before).pathname;
        const now = left ? null : await look(page);
        if (now) {
          const added = now.texts.filter((t) => !words.has(t)).length;
          const state = said(now);
          if ((added >= 2 || now.fields > from.look.fields) && !seen.has(state)) {
            seen.add(state);
            branches++;
            const steps = [...from.steps, step];
            found.push({ name: steps.map(stepLabel).join(" › "), steps });
            if (steps.length < MAX_DEPTH) {
              queue.push({ steps, look: now, worth: added + (now.fields - from.look.fields) * 5 });
              queue.sort((a, b) => b.worth - a.worth);
            }
          }
        }
        if (!now || said(now) !== said(from.look)) {
          // Back to the state this started from: Escape closes most menus and dialogs, otherwise open it again.
          if (now) {
            await page.keyboard.press("Escape");
            await page.waitForTimeout(300);
          }
          if (!now || said(await look(page)) !== said(from.look)) await open(from.steps);
        }
      }
    }
    return found;
  } finally {
    await context.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * What a flow opened: the texts and fields of the state it leads to that were not already in the same place on the
 * screen it started from, such as a dialog's form without the list behind it. A value from the list's cells, such as
 * the opened record's name or stage, is sample data that differs between the prototype and the build.
 */
export function opened(state: PageContent, start: PageContent): PageContent {
  const same = (a: Box, b: Box) => Math.abs(a.x - b.x) <= 4 && Math.abs(a.y - b.y) <= 4;
  const sample = new Set(start.elements.filter((e) => e.data).map((e) => e.text.toLowerCase()));
  return {
    elements: state.elements.filter((e) => !sample.has(e.text.toLowerCase()) && !start.elements.some((s) => s.text === e.text && same(e, s))),
    fields: state.fields.filter((f) => !start.fields.some((s) => s.type === f.type && s.label === f.label && s.hint === f.hint && same(f, s))),
  };
}
