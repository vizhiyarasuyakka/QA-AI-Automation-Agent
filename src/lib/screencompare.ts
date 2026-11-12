import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { pictureSize } from "./pixels";

/** A place on a page's screenshot, in pixels from its top left. */
export type Box = { x: number; y: number; w: number; h: number };
/** One difference, and where it is on each screenshot: the evidence drawn for it. */
export type ScreenDiff = { element: string; kind: string; prototype: string; build: string; at?: { prototype: Box[]; build: Box[] } };
/** One visible piece of text on a page: where it sits and how it looks. Colours are rgb(r,g,b), or "" for none. */
export type PageElement = { text: string; tag: string; data: boolean; x: number; y: number; w: number; h: number; size: number; weight: number; family: string; color: string; bg: string };
/**
 * One form field a person can fill in or choose: the label shown beside it, its placeholder, a name only screen readers
 * get, the kind of control, and whether a star marks it required.
 */
export type PageField = { label: string; hint: string; name: string; type: string; required: boolean; data: boolean; x: number; y: number; w: number; h: number };
export type PageContent = { elements: PageElement[]; fields: PageField[] };
export type Account = { user: string; password: string };
/** The app's cookies and storage after signing in, kept in memory for the rest of the run. */
export type Session = Awaited<ReturnType<BrowserContext["storageState"]>>;
type View = { width: number; height: number; scale: number; grow: boolean };
/** loading: placeholders were still showing when the screenshot was taken, so what it lacks may only not have loaded. */
type Capture = { shot: Uint8Array<ArrayBuffer>; content: PageContent | null; url: string; loading: boolean };

export const SCREEN_WIDTHS = [1440, 1280, 1366, 1536, 1920, 1024, 768, 390];
export const DEFAULT_WIDTH = 1440;
const VIEW_HEIGHT = 900;
const MAX_HEIGHT = 6000;
const COLOUR_TOLERANCE = 24;
const LAYOUT_TOLERANCE = 12;
const MAX_DIFFS = 80;
const CONTROLS = new Set(["button", "input", "select", "textarea"]);
/** Differences in a form field, as opposed to its texts and their looks. */
export const FIELD_KINDS: ReadonlySet<string> = new Set(["Missing field", "Extra field", "Field label", "Field type", "Required"]);
const KIND_ORDER = [...FIELD_KINDS, "Missing", "Text", "Colour", "Font", "Size", "Layout", "Extra", "Other"];
/** How far, after the page's overall shift, an unnamed field may sit from its partner and still be the same field. */
const FIELD_TOLERANCE = 40;
/** A text this close to a field that is missing or extra is that field's own label or placeholder. */
const FIELD_TEXT_GAP = 80;

const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300);

/**
 * Runs in the page: every visible piece of text with its place and style, and every form field with its label. Visible
 * means drawn and on top: not see-through through any parent, and not covered by another element, so a panel kept
 * behind another or faded out does not count. Kept as a string so the bundler cannot rewrite it.
 */
const READ_PAGE = String.raw`(() => {
  const FIELD = "input, select, textarea, [contenteditable=''], [contenteditable=true], [role=textbox], [role=combobox], [role=listbox], [role=checkbox], [role=radio], [role=switch], [role=spinbutton], [role=slider]";
  const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
  const alpha = new Map();
  const opacity = (e) => {
    if (!e || e === document.documentElement) return 1;
    if (!alpha.has(e)) alpha.set(e, (Number(getComputedStyle(e).opacity) || 0) * opacity(e.parentElement));
    return alpha.get(e);
  };
  const clear = (el) => getComputedStyle(el).visibility !== "hidden" && opacity(el) >= 0.1;
  const onTop = (el, box) => {
    if (box.width < 1 || box.height < 1) return false;
    if (getComputedStyle(el).pointerEvents === "none") return true;
    for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75]]) {
      const hit = document.elementFromPoint(box.left + box.width * fx, box.top + box.height * fy);
      if (hit && (hit === el || el.contains(hit) || hit.contains(el))) return true;
    }
    return false;
  };
  const seen = (el) => { const box = el.getBoundingClientRect(); return clear(el) && onTop(el, box) ? box : null; };
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const g = canvas.getContext("2d", { willReadFrequently: true });
  const known = new Map();
  const rgb = (c) => {
    if (!c || c === "transparent") return "";
    if (known.has(c)) return known.get(c);
    g.clearRect(0, 0, 1, 1); g.fillStyle = "#000"; g.fillStyle = c; g.fillRect(0, 0, 1, 1);
    const d = g.getImageData(0, 0, 1, 1).data;
    const v = d[3] < 13 ? "" : "rgb(" + d[0] + "," + d[1] + "," + d[2] + ")";
    known.set(c, v);
    return v;
  };
  const background = (el) => {
    for (let e = el; e; e = e.parentElement) { const v = rgb(getComputedStyle(e).backgroundColor); if (v) return v; }
    return "";
  };
  const elements = [];
  for (const el of document.body ? document.body.querySelectorAll("*") : []) {
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName) || el.closest("svg, #__bundler_loading, #__bundler_thumbnail")) continue;
    let text = "";
    for (const n of el.childNodes) if (n.nodeType === 3) text += n.textContent;
    text = text.replace(/\s+/g, " ").trim();
    const own = el.tagName.toLowerCase();
    if (!text && (own === "input" || own === "textarea")) text = (el.getAttribute("placeholder") || (/^(submit|button)$/.test(el.type) ? el.value : "") || "").trim();
    if (!text || text.length > 80) continue;
    const control = el.closest("button, [role=button], select, textarea, input");
    const box = (control || el).getBoundingClientRect();
    if (box.width < 1 || box.height < 1 || box.right <= 0 || box.left >= innerWidth) continue;
    if (!clear(el) || !onTop(control || el, box)) continue;
    const cs = getComputedStyle(el);
    elements.push({
      text, tag: control ? (control.tagName === "BUTTON" || control.getAttribute("role") === "button" ? "button" : control.tagName.toLowerCase()) : own,
      data: !!el.closest("tbody, [role=gridcell], [role=cell]"),
      x: Math.round(box.left + scrollX), y: Math.round(box.top + scrollY), w: Math.round(box.width), h: Math.round(box.height),
      size: parseFloat(cs.fontSize) || 0, weight: Number(cs.fontWeight) || 400,
      family: (cs.fontFamily.split(",")[0] || "").replace(/["']/g, "").trim(), color: rgb(cs.color), bg: background(el),
    });
    if (elements.length >= 2000) break;
  }

  const textOf = (node) => {
    let s = "";
    const walk = (n) => { for (const c of n.childNodes) { if (c.nodeType === 3) s += c.textContent; else if (c.nodeType === 1 && !c.matches(FIELD) && !/^(script|style|svg)$/i.test(c.tagName)) walk(c); } };
    walk(node);
    return s;
  };
  const starred = (el) => !!el && /\*/.test(el.textContent + getComputedStyle(el, "::before").content + getComputedStyle(el, "::after").content);
  // The name a person reads for a field: its label when it shows, the text it points to, or the nearest short text just
  // above it or to its left, and for a checkbox, radio or toggle also just to its right in the same table cell, so a
  // column heading beside a select-all box is not taken for its name. Texts are walked outwards from the field, as a
  // design's components can wrap it many levels deep.
  const labelOf = (el, box, side) => {
    for (const l of el.labels || []) { const t = clean(textOf(l)); if (t && seen(l)) return { text: t, star: starred(l) }; }
    for (const id of clean(el.getAttribute("aria-labelledby")).split(" ")) {
      const n = id && document.getElementById(id);
      const t = n && clean(n.textContent);
      if (t && seen(n)) return { text: t, star: starred(n) };
    }
    const cell = el.closest("td, th"), close = el.parentElement && el.parentElement.parentElement;
    let root = el;
    for (let i = 0; i < 8 && root.parentElement; i++) root = root.parentElement;
    let best = { text: "", star: false }, gap = Infinity;
    const consider = (n, after) => {
      const host = n.parentElement, t = clean(n.textContent);
      if (!host || !t || t.length > 60 || !/\p{L}/u.test(t) || host.closest(FIELD + ", button, a, [role=button], option")) return;
      if (host.closest("td, th") !== cell && host.closest("tbody, [role=gridcell], [role=cell]")) return;
      const range = document.createRange();
      range.selectNodeContents(n);
      const r = range.getBoundingClientRect();
      const row = Math.abs((r.top + r.bottom) / 2 - (box.top + box.bottom) / 2) <= box.height / 2 + 4;
      const d = after ? (close && close.contains(host) && host.closest("td, th") === cell && row && r.left >= box.right - 4 && r.left - box.right <= 40 ? r.left - box.right : Infinity)
        : r.bottom <= box.top + 4 && box.top - r.bottom <= 40 && r.left < box.right && r.right > box.left - 24 ? box.top - r.bottom
        : row && r.right <= box.left + 4 && box.left - r.right <= 160 ? box.left - r.right : Infinity;
      if (d >= gap || !r.width || !seen(host)) return;
      gap = d;
      best = { text: t, star: starred(host) || (!!host.parentElement && host.parentElement.textContent.length <= 80 && starred(host.parentElement)) };
    };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    walker.currentNode = el;
    for (let n = walker.previousNode(), k = 0; n && k < 150; n = walker.previousNode(), k++) consider(n, false);
    // Words to the right name a checkbox only when nothing above or to its left does, as a rating's value sits beside it.
    if (side && !best.text) {
      let last = el;
      while (last.lastChild) last = last.lastChild;
      walker.currentNode = last;
      for (let n = walker.nextNode(), k = 0; n && k < 20; n = walker.nextNode(), k++) consider(n, true);
    }
    return best;
  };
  const typeOf = (el) => {
    const role = el.getAttribute("role");
    if (el.tagName === "SELECT" || role === "combobox" || role === "listbox") return "dropdown";
    if (el.tagName === "TEXTAREA" || el.isContentEditable || (role === "textbox" && el.getAttribute("aria-multiline") === "true")) return "text area";
    const byRole = { checkbox: "checkbox", radio: "radio", switch: "toggle", spinbutton: "number", slider: "slider", textbox: "text" }[role];
    if (byRole) return byRole;
    const t = (el.getAttribute("type") || "text").toLowerCase();
    return { range: "slider", "datetime-local": "date", month: "date", week: "date" }[t] || t;
  };
  const fields = [];
  for (const el of document.body ? document.body.querySelectorAll(FIELD) : []) {
    if (el.closest("svg, #__bundler_loading, #__bundler_thumbnail") || (el.parentElement && el.parentElement.closest(FIELD))) continue;
    if (el.tagName === "INPUT" && /^(hidden|submit|button|reset|image)$/i.test(el.type)) continue;
    const type = typeOf(el);
    const check = /^(checkbox|radio|toggle)$/.test(type);
    // A styled checkbox or radio hides the real one and shows its label in its place.
    const face = seen(el) || (check ? [...(el.labels || [])].map(seen).find(Boolean) : null);
    if (!face || face.right <= 0 || face.left >= innerWidth) continue;
    const own = el.getBoundingClientRect();
    const label = labelOf(el, own.width >= 1 ? own : face, check);
    const hint = clean(el.getAttribute("placeholder"));
    // A label kept for screen readers only is a name a person does not see.
    const unseen = [...(el.labels || [])].map((l) => clean(textOf(l))).find(Boolean);
    const name = el.getAttribute("aria-label") || unseen || el.getAttribute("title") || (el.getAttribute("name") || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
    fields.push({
      label: label.text.replace(/[\s:*]+$/, ""), hint: hint.replace(/[\s*]+$/, ""), name: clean(name), type, required: label.star || /\*$/.test(hint),
      data: !!el.closest("tbody, [role=gridcell], [role=cell]"),
      x: Math.round(face.left + scrollX), y: Math.round(face.top + scrollY), w: Math.round(face.width), h: Math.round(face.height),
    });
    if (fields.length >= 300) break;
  }
  return { elements, fields };
})()`;

/** A design bundle shows a loading badge until it has drawn itself. */
const LOADING_GONE = "![...document.querySelectorAll('#__bundler_loading, #__bundler_thumbnail')].some((e) => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0)";

/** Text as compared: case, spacing and trailing colons or stars do not count. */
const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ").replace(/[\s:*]+$/, "").trim();
/** Table cells and any text with a number in it (counts, amounts, dates, IDs) are sample data that differs by design. */
const sampleData = (e: PageElement) => e.data || !/\p{L}/u.test(e.text) || /\d/.test(e.text);
/** The font's own name: Next.js serves Inter as __Inter_d8ebd1, with a fallback face beside it. */
const fontName = (f: string) => f.replace(/^_+/, "").replace(/_[0-9a-f]{4,}$/i, "").replace(/\s+fallback$/i, "").toLowerCase();
const hex = (c: string) => {
  const m = c.match(/^rgb\((\d+),(\d+),(\d+)\)$/);
  return m ? `#${m.slice(1).map((n) => Number(n).toString(16).padStart(2, "0")).join("")}` : "none";
};
const colourGap = (a: string, b: string) => {
  const pa = a.match(/\d+/g)?.map(Number), pb = b.match(/\d+/g)?.map(Number);
  if (!pa || !pb) return a === b ? 0 : Infinity;
  return Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
};
const middle = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
const names = (list: string[]) => `${list.length} elements: ${list.slice(0, 4).join(", ")}${list.length > 4 ? ` and ${list.length - 4} more` : ""}`;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const boxOf = (e: Box): Box => ({ x: e.x, y: e.y, w: e.w, h: e.h });
const shifted = (b: Box, dx: number, dy: number): Box => ({ ...b, x: b.x + dx, y: b.y + dy });
const within = (a: Box, b: Box, gap: number) => a.x <= b.x + b.w + gap && b.x <= a.x + a.w + gap && a.y <= b.y + b.h + gap && b.y <= a.y + a.h + gap;

const FIELD_KIND: Record<string, string> = { text: "text box", search: "search box", email: "email box", tel: "phone box", url: "web address box", number: "number box", date: "date box", time: "time box", password: "password box", file: "file upload", color: "colour picker", radio: "radio button" };
const fieldKind = (type: string) => FIELD_KIND[type] ?? type;
/** Controls a person fills in the same way: a prototype often draws an email, number or date box as a plain text box. */
const TEXT_LIKE = new Set(["text", "search", "email", "tel", "url", "number", "date", "time"]);
const family = (type: string) => (TEXT_LIKE.has(type) ? "text" : type);
/** What a field is called: the label shown beside it, else its placeholder, else the name only screen readers get. */
const fieldName = (f: PageField) => f.label || f.hint || f.name;
const fieldTitle = (f: PageField) => fieldName(f) || `Unnamed ${fieldKind(f.type)}`;
const fieldKeys = (f: PageField) => [f.label, f.hint, f.name].map(norm).filter(Boolean);
const describe = (f: PageField) => [fieldKind(f.type), f.label && `label "${f.label}"`, f.hint && `placeholder "${f.hint}"`, f.required && "marked required (*)"].filter(Boolean).join(", ");
const marked = (required: boolean) => (required ? "marked required (*)" : "not marked required");

type Row = ScreenDiff & { group?: string; merged?: { prototype: string; build: string } };
/** How far the build moved the part of the page around a place on one side's screenshot. */
type ShiftNear = (b: Box, side: "prototype" | "build") => { dx: number; dy: number };

/**
 * Field by field. Each prototype field is paired with the build's by the name a person reads, then by any name they
 * share, then, for unnamed ones, by kind and place. What is left is missing from the build or not in the prototype.
 * Fields inside table rows are sample data and are not compared.
 */
function compareFields(prototype: PageField[], app: PageField[], shiftNear: ShiftNear) {
  let ps = prototype.filter((f) => !f.data), as = app.filter((f) => !f.data);
  const count = { prototype: ps.length, build: as.length };
  const pairs: [PageField, PageField][] = [];
  const gap = (p: PageField, a: PageField) => {
    const { dx, dy } = shiftNear(p, "prototype");
    return Math.hypot(a.x - p.x - dx, a.y - p.y - dy);
  };
  const pairBy = (same: (p: PageField, a: PageField) => boolean) => {
    for (const p of [...ps]) {
      const a = as.filter((x) => same(p, x)).sort((x, y) => gap(p, x) - gap(p, y))[0];
      if (!a) continue;
      pairs.push([p, a]);
      ps = ps.filter((x) => x !== p);
      as = as.filter((x) => x !== a);
    }
  };
  const key = (f: PageField) => norm(fieldName(f));
  pairBy((p, a) => !!key(p) && key(p) === key(a));
  pairBy((p, a) => fieldKeys(p).some((k) => fieldKeys(a).includes(k)));
  pairBy((p, a) => family(p.type) === family(a.type) && gap(p, a) <= FIELD_TOLERANCE);

  const rows: Row[] = [];
  const covers = { prototype: [...ps], build: [...as] };
  for (const [p, a] of pairs) {
    const element = fieldTitle(p), at = { prototype: [boxOf(p)], build: [boxOf(a)] };
    // A label shown on one side only is a text missing or extra, reported with the texts.
    if (p.label && a.label && norm(p.label) !== norm(a.label)) {
      rows.push({ kind: "Field label", element, prototype: `label "${p.label}"`, build: `label "${a.label}"`, at });
      covers.prototype.push(p);
      covers.build.push(a);
    }
    if (family(p.type) !== family(a.type)) {
      rows.push({ kind: "Field type", element, prototype: fieldKind(p.type), build: fieldKind(a.type), at });
      covers.prototype.push(p);
      covers.build.push(a);
    }
    if (p.required !== a.required) rows.push({ kind: "Required", element, prototype: marked(p.required), build: marked(a.required), at });
  }
  for (const p of ps) {
    const { dx, dy } = shiftNear(p, "prototype");
    rows.push({ kind: "Missing field", element: fieldTitle(p), prototype: describe(p), build: "", at: { prototype: [boxOf(p)], build: [shifted(boxOf(p), dx, dy)] } });
  }
  for (const a of as) {
    const { dx, dy } = shiftNear(a, "build");
    rows.push({ kind: "Extra field", element: fieldTitle(a), prototype: "", build: describe(a), at: { prototype: [shifted(boxOf(a), -dx, -dy)], build: [boxOf(a)] } });
  }
  // The same difference on several fields of one group, such as each star of a rating, is one row with all their boxes.
  const merged = new Map<string, Row & { n: number }>();
  for (const r of rows) {
    const key = `${r.kind}|${r.element}|${r.prototype}|${r.build}`, seen = merged.get(key);
    if (!seen) merged.set(key, { ...r, n: 1 });
    else {
      seen.n++;
      seen.at = { prototype: [...(seen.at?.prototype ?? []), ...(r.at?.prototype ?? [])], build: [...(seen.at?.build ?? []), ...(r.at?.build ?? [])] };
    }
  }
  return { rows: [...merged.values()].map(({ n, ...r }) => (n > 1 ? { ...r, element: `${r.element} (${n} fields)` } : r)), covers, count };
}

/**
 * Every way the app's page differs from the prototype's. Form fields first: missing from the build, in the build but
 * not in the prototype, or with another label, kind or required mark. Then text by text: missing, extra or reworded,
 * and for the same text its colour, background, font, size and place. Places are compared after the page's overall
 * shift, which is reported once, and a change seen on three or more elements is reported once. Each difference keeps
 * its place on both screenshots; where an element is absent, the place it would take.
 */
export function compareElements(prototype: PageContent, app: PageContent): { differences: ScreenDiff[]; fields: { prototype: number; build: number } } {
  const byText = (els: PageElement[]) => {
    const m = new Map<string, PageElement[]>();
    for (const e of els) {
      const k = norm(e.text);
      if (!k || sampleData(e)) continue;
      const list = m.get(k) ?? [];
      // The same text drawn twice in one place, such as a label and its copy, is one element.
      if (!list.some((o) => Math.abs(o.x - e.x) <= 4 && Math.abs(o.y - e.y) <= 4)) m.set(k, [...list, e]);
    }
    for (const list of m.values()) list.sort((a, b) => a.y - b.y || a.x - b.x);
    return m;
  };
  const P = byText(prototype.elements), A = byText(app.elements);
  const pairs: [PageElement, PageElement][] = [];
  let missing: PageElement[] = [], extra: PageElement[] = [];
  for (const [k, ps] of P) {
    const as = A.get(k) ?? [];
    ps.forEach((p, i) => (as[i] ? pairs.push([p, as[i]]) : missing.push(p)));
  }
  for (const [k, as] of A) extra.push(...as.slice((P.get(k) ?? []).length));
  const dx = middle(pairs.map(([p, a]) => a.x - p.x)), dy = middle(pairs.map(([p, a]) => a.y - p.y));
  const at = (e: PageElement) => `${e.tag} at ${e.x},${e.y}`;
  const both = (p: PageElement, a: PageElement) => ({ prototype: [boxOf(p)], build: [boxOf(a)] });
  // The shift of the nearest text found on both pages that comes before the place, above it or on its row: an element
  // belongs after what precedes it, and what sits below a list grown with more sample rows is looked for where it
  // went. Without such a text, the nearest one; without any, the page's overall shift.
  const shiftNear: ShiftNear = (b, side) => {
    const middleY = (e: Box) => e.y + e.h / 2;
    let best: [PageElement, PageElement] | null = null, gap = Infinity, before = false;
    for (const pair of pairs) {
      const e = pair[side === "prototype" ? 0 : 1], d = Math.hypot(e.x - b.x, e.y - b.y), above = middleY(e) <= middleY(b) + 4;
      if ((above && !before) || (above === before && d < gap)) [best, gap, before] = [pair, d, above];
    }
    return best ? { dx: best[1].x - best[0].x, dy: best[1].y - best[0].y } : { dx, dy };
  };

  const fields = compareFields(prototype.fields, app.fields, shiftNear);
  const rows: Row[] = [...fields.rows];
  // The label or placeholder of a field reported above, and any text drawn inside it such as a dropdown's chosen value,
  // are that field, not texts of their own.
  const inside = (e: Box, f: Box) => e.x >= f.x - 2 && e.y >= f.y - 2 && e.x + e.w <= f.x + f.w + 2 && e.y + e.h <= f.y + f.h + 2;
  const ofField = (e: PageElement, side: "prototype" | "build") => fields.covers[side].some((f) => inside(e, f) || (fieldKeys(f).includes(norm(e.text)) && within(e, f, FIELD_TEXT_GAP)));
  missing = missing.filter((p) => !ofField(p, "prototype"));
  extra = extra.filter((a) => !ofField(a, "build"));

  if (Math.abs(dx) > LAYOUT_TOLERANCE || Math.abs(dy) > LAYOUT_TOLERANCE) rows.push({ kind: "Layout", element: "The whole page", prototype: "as in the prototype", build: `everything moved ${dx}px across and ${dy}px down` });
  // A missing text and an extra one of the same kind in the same place is changed wording.
  for (const p of [...missing]) {
    const s = shiftNear(p, "prototype");
    const a = extra.find((e) => e.tag === p.tag && Math.abs(e.x - p.x - s.dx) <= 24 && Math.abs(e.y - p.y - s.dy) <= 24);
    if (!a) continue;
    rows.push({ kind: "Text", element: p.text, prototype: p.text, build: a.text, at: both(p, a) });
    missing = missing.filter((e) => e !== p);
    extra = extra.filter((e) => e !== a);
  }
  for (const p of missing) {
    const s = shiftNear(p, "prototype");
    rows.push({ kind: "Missing", element: p.text, prototype: at(p), build: "", at: { prototype: [boxOf(p)], build: [shifted(boxOf(p), s.dx, s.dy)] } });
  }
  for (const [p, a] of pairs) {
    const style = (kind: string, pv: string, av: string) => rows.push({ kind, element: p.text, prototype: pv, build: av, group: `${kind}|${pv}|${av}`, at: both(p, a) });
    if (colourGap(p.color, a.color) > COLOUR_TOLERANCE) style("Colour", `text ${hex(p.color)}`, `text ${hex(a.color)}`);
    if (colourGap(p.bg, a.bg) > COLOUR_TOLERANCE) style("Colour", `background ${hex(p.bg)}`, `background ${hex(a.bg)}`);
    if (Math.abs(p.size - a.size) >= 1) style("Size", `${p.size}px text`, `${a.size}px text`);
    if (p.weight !== a.weight) style("Font", `weight ${p.weight}`, `weight ${a.weight}`);
    if (fontName(p.family) !== fontName(a.family)) style("Font", p.family || "default font", a.family || "default font");
    if (CONTROLS.has(p.tag) && (Math.abs(p.w - a.w) > 8 || Math.abs(p.h - a.h) > 6)) rows.push({ kind: "Size", element: p.text, prototype: `${p.w}×${p.h}`, build: `${a.w}×${a.h}`, at: both(p, a) });
    const mx = a.x - p.x - dx, my = a.y - p.y - dy;
    if (Math.abs(mx) > LAYOUT_TOLERANCE || Math.abs(my) > LAYOUT_TOLERANCE) {
      rows.push({ kind: "Layout", element: p.text, prototype: `at ${p.x},${p.y}`, build: `at ${a.x},${a.y}`, group: `Layout|${mx}|${my}`, merged: { prototype: "as in the prototype", build: `moved ${mx}px across and ${my}px down` }, at: both(p, a) });
    }
  }
  for (const a of extra) {
    const s = shiftNear(a, "build");
    rows.push({ kind: "Extra", element: a.text, prototype: "", build: at(a), at: { prototype: [shifted(boxOf(a), -s.dx, -s.dy)], build: [boxOf(a)] } });
  }

  const groups = new Map<string, Row[]>();
  for (const r of rows) if (r.group) groups.set(r.group, [...(groups.get(r.group) ?? []), r]);
  const out: ScreenDiff[] = [];
  for (const r of rows) {
    const same = r.group ? groups.get(r.group)! : [];
    if (same.length < 3) out.push({ element: r.element, kind: r.kind, prototype: r.prototype, build: r.build, ...(r.at ? { at: r.at } : {}) });
    else if (same[0] === r) {
      const at = { prototype: same.flatMap((x) => x.at?.prototype ?? []), build: same.flatMap((x) => x.at?.build ?? []) };
      out.push({ element: names(same.map((x) => x.element)), kind: r.kind, prototype: r.merged?.prototype ?? r.prototype, build: r.merged?.build ?? r.build, at });
    }
  }
  out.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  const differences = out.length > MAX_DIFFS ? [...out.slice(0, MAX_DIFFS), { element: `${out.length - MAX_DIFFS} more differences`, kind: "Other", prototype: "", build: "" }] : out;
  return { differences, fields: fields.count };
}

/** Google Chrome installed on this machine, run without a window. Playwright's own Chromium is the fallback. */
export async function openChrome(): Promise<Browser> {
  try {
    return await chromium.launch({ channel: "chrome", headless: true });
  } catch (e) {
    try {
      return await chromium.launch({ headless: true });
    } catch {
      throw new Error(`Chrome could not start. Install Google Chrome, or run npx playwright install chromium. ${firstLine(e)}`);
    }
  }
}

/**
 * A page still drawing its data shows placeholders in its place: skeleton bars, shimmering, pulsing or spinning shapes,
 * or a part marked busy. A small pulsing dot is a decoration, not a placeholder.
 */
const STILL_LOADING = String.raw`[...document.querySelectorAll('[aria-busy="true"], [class*="skeleton" i], [class*="shimmer" i], .animate-pulse, .animate-spin')].some((e) => { const r = e.getBoundingClientRect(); return r.width * r.height >= 200 && getComputedStyle(e).visibility !== "hidden"; })`;

/** Waits, up to a limit, until the page has loaded its data and stopped drawing placeholders in its place. */
export async function settle(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.waitForFunction(LOADING_GONE, undefined, { timeout: 20_000 }).catch(() => {});
  await page.waitForFunction(`!(${STILL_LOADING})`, undefined, { timeout: 20_000 }).catch(() => {});
  await page.evaluate("document.fonts ? document.fonts.ready.then(() => true) : true").catch(() => {});
  await page.waitForTimeout(700);
}

/**
 * How tall the window must be to show the whole page: the page's own scroll height, or for an app that scrolls inside a
 * full-height box, the window plus what that box hides.
 */
const FULL_HEIGHT = String.raw`(() => {
  let hidden = 0;
  for (const e of document.querySelectorAll("body *")) {
    if (e.clientHeight < 200 || e.scrollHeight <= e.clientHeight + 1) continue;
    if (/(auto|scroll)/.test(getComputedStyle(e).overflowY)) hidden = Math.max(hidden, e.scrollHeight - e.clientHeight);
  }
  return Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0, innerHeight + hidden);
})()`;

/** Makes the window as tall as the page, so fixed side bars and inner scroll boxes show all of it. */
export async function grow(page: Page, width: number) {
  let height = page.viewportSize()?.height ?? VIEW_HEIGHT;
  // Twice, because a box made taller can show more that loads in.
  for (let i = 0; i < 2; i++) {
    const next = Math.min(MAX_HEIGHT, Math.max(height, await page.evaluate<number>(FULL_HEIGHT)));
    if (next === height) break;
    height = next;
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(600);
  }
}

/** A screenshot of the page as it stands. A growing view is first made as tall as the page. */
async function captureView(page: Page, view: View, withElements: boolean): Promise<Capture> {
  await settle(page);
  if (view.grow) {
    await grow(page, view.width);
    await page.waitForFunction(`!(${STILL_LOADING})`, undefined, { timeout: 10_000 }).catch(() => {});
  }
  const shot = await page.screenshot({ animations: "disabled", caret: "hide" });
  const content = withElements ? await page.evaluate<PageContent>(READ_PAGE) : null;
  const loading = await page.evaluate<boolean>(STILL_LOADING).catch(() => false);
  return { shot: new Uint8Array(shot), content, url: page.url(), loading };
}

function kindOf(p: { fileName: string; mimeType: string }) {
  const ext = path.extname(p.fileName).toLowerCase();
  if (p.mimeType === "text/html" || ext === ".html" || ext === ".htm") return "html";
  if (p.mimeType === "image/svg+xml" || ext === ".svg") return "svg";
  if (p.mimeType.startsWith("image/")) return "picture";
  return p.mimeType === "application/pdf" || ext === ".pdf" ? "pdf" : "other";
}

/**
 * The prototype as a picture, and the size to open the app at. A picture is used as it is; an HTML or SVG prototype is
 * drawn by Chrome at the chosen width, and an HTML one also gives its texts, styles and form fields. With steps, the
 * prototype is clicked through them first and the state they lead to is drawn.
 */
export async function renderPrototype(browser: Browser, proto: { fileName: string; mimeType: string; bytes: Uint8Array }, width: number, steps: Step[] = [], height = VIEW_HEIGHT): Promise<{ capture: Capture; view: View; rendered: boolean } | { blocked: string }> {
  const kind = kindOf(proto);
  if (steps.length && kind !== "html") return { blocked: "Only an HTML prototype can be clicked through." };
  if (kind === "picture") {
    const size = await pictureSize(proto.bytes);
    if (!size) return { blocked: `${proto.fileName} is not a picture that can be read.` };
    // A 2x or 3x export of a design at the chosen width is the same design on a sharper screen.
    const scale = [2, 3].find((s) => size.width === width * s) ?? 1;
    return { capture: { shot: new Uint8Array(proto.bytes), content: null, url: "", loading: false }, view: { width: Math.round(size.width / scale), height: Math.min(MAX_HEIGHT, Math.round(size.height / scale)), scale, grow: false }, rendered: false };
  }
  if (kind !== "html" && kind !== "svg") return { blocked: `A ${kind === "pdf" ? "PDF" : "file of this kind"} cannot be compared pixel by pixel. Upload the screen as PNG, JPG, WEBP or HTML.` };
  const dir = mkdtempSync(path.join(os.tmpdir(), "qa-proto-"));
  // A flow starts at the screen's full height: a popover that a window resize would close then stays open.
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: "reduce" });
  try {
    const file = path.join(dir, `prototype.${kind}`);
    writeFileSync(file, proto.bytes);
    const page = await context.newPage();
    await page.goto(pathToFileURL(file).href, { waitUntil: "load", timeout: 60_000 });
    if (steps.length) {
      await settle(page);
      const at = (await follow(page, steps, true)).missing;
      if (at !== null) return { blocked: `The prototype has no ${steps[at].role} named "${stepLabel(steps[at])}" to click any more.` };
    }
    const view = { width, height, scale: 1, grow: true };
    return { capture: await captureView(page, view, kind === "html"), view, rendered: true };
  } catch (e) {
    return { blocked: `Chrome could not draw the prototype. ${firstLine(e)}` };
  } finally {
    await context.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

const passwordField = (page: Page) => page.locator('input[type="password"]:visible').first();

/** Fills the app's own sign-in form. Errors are swallowed on purpose: their text could carry what was typed. */
async function signIn(page: Page, account: Account): Promise<boolean> {
  try {
    const password = passwordField(page);
    const form = page.locator("form").filter({ has: page.locator('input[type="password"]') }).first();
    const scope = (await form.count()) ? form : page.locator("body");
    const user = scope.locator("input:visible:not([type=password]):not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=search])").first();
    if (await user.count()) await user.fill(account.user);
    await password.fill(account.password);
    const submit = scope.locator("button[type=submit]:visible, input[type=submit]:visible").first();
    const named = scope.getByRole("button", { name: /^\s*(sign ?in|log ?in|login|continue|submit)\s*$/i }).first();
    if (await submit.count()) await submit.click();
    else if (await named.count()) await named.click();
    else await password.press("Enter");
    // A slow app can take most of a minute to sign in.
    await passwordField(page).waitFor({ state: "hidden", timeout: 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** With no page given, follow the app's own navigation: a link, tab or menu item named like the screen. */
async function findScreen(page: Page, screen: string): Promise<boolean> {
  const words = screen.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);
  for (let i = 0; i < words.length; i++) {
    const name = new RegExp(`^\\s*${words.slice(i).map(escapeRegExp).join("[\\s_-]*")}\\s*$`, "i");
    for (const role of ["link", "menuitem", "tab", "button"] as const) {
      const hit = page.getByRole(role, { name }).filter({ visible: true }).first();
      if (await hit.count()) {
        const from = page.url();
        await hit.click();
        // An app that routes in the page changes its address a moment after the click, once the next screen has loaded.
        await page.waitForURL((u) => u.href !== from, { timeout: 10_000 }).catch(() => {});
        await page.waitForLoadState("load").catch(() => {});
        return true;
      }
    }
  }
  return false;
}

/** One click of a flow: a control by its role and the name a person reads, or "row" to open the first row of a list. */
export type Step = { role: "button" | "link" | "tab" | "menuitem" | "row"; name: string };
const ROLES = ["button", "link", "tab", "menuitem"] as const;
/** How a step reads in a flow's name. */
export const stepLabel = (s: Step) => (s.role === "row" ? "first row" : s.name);

/**
 * Runs in the page: marks the first row of a list and the place to click to open it. The row is a table body's first,
 * or of rows marked as rows, the first shaped like most of them, as the heading row is not. The place is its first
 * link, else its first words outside any control, past a checkbox column.
 */
const MARK_FIRST_ROW = String.raw`(() => {
  for (const e of document.querySelectorAll("[data-qa-row], [data-qa-open]")) { e.removeAttribute("data-qa-row"); e.removeAttribute("data-qa-open"); }
  const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  let row = [...document.querySelectorAll("tbody tr")].find(visible);
  if (!row) {
    const rows = [...document.querySelectorAll("[role=row]")].filter((r) => visible(r) && !r.closest("thead") && !r.querySelector("[role=columnheader]"));
    const shape = (r) => r.className + "|" + Math.round(r.getBoundingClientRect().height);
    const counts = new Map();
    for (const r of rows) counts.set(shape(r), (counts.get(shape(r)) || 0) + 1);
    const most = Math.max(0, ...counts.values());
    row = most >= 2 ? rows.find((r) => counts.get(shape(r)) === most) : null;
  }
  if (!row) return false;
  row.setAttribute("data-qa-row", "");
  const link = [...row.querySelectorAll("a[href]")].find(visible);
  let open = link || null;
  if (!open) {
    for (const e of row.querySelectorAll("*")) {
      if (e.closest("button, a, input, select, textarea, [role=button], [role=checkbox], [role=combobox]") || !visible(e)) continue;
      let t = "";
      for (const n of e.childNodes) if (n.nodeType === 3) t += n.textContent;
      if (/\p{L}/u.test(t)) { open = e; break; }
    }
  }
  (open || row).setAttribute("data-qa-open", "");
  return true;
})()`;

/** Where what a click opened lives: a dialog, menu, list box or open panel. */
const OPENED = "[role=dialog], [role=alertdialog], [role=menu], [role=listbox], [aria-modal=true], [data-radix-popper-content-wrapper], [data-state=open]";

/**
 * The control a step clicks: a visible one of its role and name, with the name in any case or under another role as a
 * fallback, and last the words themselves, as an app can make plain text clickable. A match inside a menu or panel
 * the last click opened wins over any other, as the next step belongs to it; a sort button of the same name behind it
 * does not. For a row, the place that opens the list's first row. Null when there is none.
 */
export async function findControl(page: Page, step: Step): Promise<Locator | null> {
  if (step.role === "row") return (await page.evaluate<boolean>(MARK_FIRST_ROW)) ? page.locator("[data-qa-open]").first() : null;
  const loose = new RegExp(`^\\s*${escapeRegExp(step.name)}\\s*$`, "i");
  const tries = [page.getByRole(step.role, { name: step.name, exact: true }), ...[step.role, ...ROLES.filter((r) => r !== step.role)].map((role) => page.getByRole(role, { name: loose })), page.getByText(loose)].map((m) => m.filter({ visible: true }));
  for (const matches of tries) {
    const n = Math.min(await matches.count(), 10);
    for (let i = 0; i < n; i++) if (await matches.nth(i).evaluate((e, sel) => !!e.closest(sel), OPENED)) return matches.nth(i);
  }
  for (const matches of tries) if (await matches.count()) return matches.first();
  return null;
}

/**
 * Clicks a flow's steps in turn. Missing is the number of the first step the page has no control for, or null when
 * every step was clicked; moved tells whether the last click led to another page rather than opening something on the
 * same one. A prototype draws at once, so quick only pauses; the app is given time to load what it opens.
 */
export async function follow(page: Page, steps: Step[], quick = false): Promise<{ missing: number | null; moved: boolean }> {
  let moved = true;
  for (const [i, step] of steps.entries()) {
    // The window is made as tall as a page before its first click, not after: what a click opens, such as a popover,
    // closes when the window resizes, so it is never resized while something is open.
    if (moved) await grow(page, page.viewportSize()?.width ?? DEFAULT_WIDTH);
    const control = await findControl(page, step);
    if (!control) return { missing: i, moved };
    const from = page.url();
    if (!(await control.click({ timeout: 10_000 }).then(() => true, () => false))) return { missing: i, moved };
    if (quick) await page.waitForTimeout(700);
    else {
      // A step that opens another page changes the address a moment later; one that opens a dialog does not.
      await page.waitForURL((u) => u.href !== from, { timeout: 2_500 }).catch(() => {});
      await settle(page);
    }
    moved = page.url() !== from;
  }
  return { missing: null, moved };
}

/**
 * The app's screen at the prototype's size. Signs in with the test account when a password field shows, keeps that
 * session for the next screens, and finds the screen by its name when no page is given. With steps, clicks through
 * them on the screen first; missing is the number of the step the app has no control for, and the screenshot shows
 * where it stopped.
 */
export async function captureApp(browser: Browser, opts: { url: string | null; home: string; screen: string; view: View; withElements: boolean; account: Account; session?: Session; steps?: Step[] }): Promise<{ capture: Capture; session: Session; missing?: number } | { blocked: string }> {
  const context = await browser.newContext({ viewport: { width: opts.view.width, height: opts.view.height }, deviceScaleFactor: opts.view.scale, reducedMotion: "reduce", ignoreHTTPSErrors: true, storageState: opts.session });
  try {
    const page = await context.newPage();
    const target = opts.url ?? opts.home;
    const open = async () => {
      try {
        await page.goto(target, { waitUntil: "load", timeout: 45_000 });
        // A redirect made by the page's own script, such as to its sign-in page, comes after the load: settle until the address stays put.
        for (let i = 0, url = ""; i < 3 && url !== page.url(); i++) {
          url = page.url();
          await settle(page);
        }
        return null;
      } catch (e) {
        return `Could not open ${target}. ${firstLine(e)}`;
      }
    };
    let signedIn = false;
    const again = "The app asked to sign in again after signing in with the saved test account.";
    /**
     * Opens the page, signing in first when the app asks. A screen found by its name is looked for from wherever
     * signing in lands, as the URL to test is often the sign-in page itself.
     */
    const reach = async (): Promise<string | null> => {
      const problem = await open();
      if (problem || !(await passwordField(page).count())) return problem;
      if (signedIn) return again;
      if (!opts.account.user || !opts.account.password) return "The app asks to sign in. Save a test account at the top of this step.";
      if (!(await signIn(page, opts.account))) return "Signing in with the saved test account did not work: the sign-in page is still showing.";
      signedIn = true;
      if (opts.url) return reach();
      await settle(page);
      return (await passwordField(page).count()) ? again : null;
    };
    for (let round = 0; ; round++) {
      const problem = await reach();
      if (problem) return { blocked: problem };
      if (!opts.url && !(await findScreen(page, opts.screen))) return { blocked: `No link named like ${opts.screen} was found on ${page.url()}. Type the page for this screen, for example /accounts.` };
      if (new URL(page.url()).origin !== new URL(opts.home).origin) return { blocked: `The page moved to ${new URL(page.url()).origin}, which is not the URL to test.` };
      const steps = opts.steps ?? [];
      const { missing, moved } = steps.length ? await follow(page, steps) : { missing: null, moved: true };
      if (new URL(page.url()).origin !== new URL(opts.home).origin) return { blocked: `The flow left the URL to test for ${new URL(page.url()).origin}.` };
      // What the last click opened on the same page, such as a popover, can make the page taller and closes when the
      // window resizes, so the window keeps the full height it was given before that click.
      const view = moved ? opts.view : { ...opts.view, grow: false };
      const capture = await captureView(page, view, opts.withElements);
      if (!(await passwordField(page).count())) return { capture, session: await context.storageState(), ...(missing === null ? {} : { missing }) };
      // The sign-in page can come up after the screen started to draw. It is never compared as the screen: sign in once more and take it again.
      if (round || signedIn) return { blocked: "The app showed its sign-in page instead of the screen." };
    }
  } finally {
    await context.close().catch(() => {});
  }
}

/** What READ_PAGE reads: every text and form field shown, with its place. */
export const readPage = (page: Page) => page.evaluate<PageContent>(READ_PAGE);
/** True when the app is showing its sign-in page. */
export const askedToSignIn = async (page: Page) => (await passwordField(page).count()) > 0;

/**
 * The app open in a window of its own, signed in, for checks that act on it. With no page given, the screen is found
 * by its name from wherever signing in lands, and with no name either, the page signing in lands on is kept. The
 * caller closes the context.
 */
export async function openApp(browser: Browser, opts: { url: string | null; home: string; screen: string; width: number; account: Account; session?: Session }): Promise<{ page: Page; context: BrowserContext; session: Session } | { blocked: string }> {
  const context = await browser.newContext({ viewport: { width: opts.width, height: VIEW_HEIGHT }, reducedMotion: "reduce", ignoreHTTPSErrors: true, storageState: opts.session });
  const page = await context.newPage();
  const fail = async (blocked: string) => {
    await context.close().catch(() => {});
    return { blocked };
  };
  const target = opts.url ?? opts.home;
  // Not the load event: an app with long-lived connections fires it late or never. Settling waits for the page's own loaders instead.
  const open = async () => {
    try {
      await page.goto(target, { waitUntil: "commit", timeout: 45_000 });
      await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
      for (let i = 0, url = ""; i < 3 && url !== page.url(); i++) {
        url = page.url();
        await settle(page);
      }
      return null;
    } catch (e) {
      return `Could not open ${target}. ${firstLine(e)}`;
    }
  };
  let problem = await open();
  if (!problem && (await passwordField(page).count())) {
    let signedIn = !!opts.account.user && !!opts.account.password && (await signIn(page, opts.account));
    // A slow sign-in gets a second try from a fresh sign-in page; an app that finished signing in late shows no sign-in page then.
    if (!signedIn && opts.account.user && opts.account.password && !(await open())) signedIn = !(await passwordField(page).count()) || (await signIn(page, opts.account));
    if (!opts.account.user || !opts.account.password) problem = "The app asks to sign in. Save a test account at the top of this step.";
    else if (!signedIn) problem = "Signing in with the saved test account did not work: the sign-in page is still showing.";
    else if (opts.url) {
      problem = await open();
      if (!problem && (await passwordField(page).count())) problem = "The app asked to sign in again after signing in with the saved test account.";
    } else await settle(page);
  }
  if (problem) return fail(problem);
  if (!opts.url && opts.screen && !(await findScreen(page, opts.screen))) return fail(`No link named like ${opts.screen} was found on ${page.url()}. Type the page for this flow, for example /boq.`);
  if (new URL(page.url()).origin !== new URL(opts.home).origin) return fail(`The page moved to ${new URL(page.url()).origin}, which is not the URL to test.`);
  return { page, context, session: await context.storageState() };
}
