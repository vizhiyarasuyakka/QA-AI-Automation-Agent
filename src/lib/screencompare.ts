import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { pictureSize } from "./pixels";

export type ScreenDiff = { element: string; kind: string; prototype: string; build: string };
/** One visible piece of text on a page: where it sits and how it looks. Colours are rgb(r,g,b), or "" for none. */
export type PageElement = { text: string; tag: string; data: boolean; x: number; y: number; w: number; h: number; size: number; weight: number; family: string; color: string; bg: string };
export type Account = { user: string; password: string };
/** The app's cookies and storage after signing in, kept in memory for the rest of the run. */
export type Session = Awaited<ReturnType<BrowserContext["storageState"]>>;
type View = { width: number; height: number; scale: number; grow: boolean };
type Capture = { shot: Uint8Array<ArrayBuffer>; elements: PageElement[] | null; url: string };

export const SCREEN_WIDTHS = [1440, 1280, 1366, 1536, 1920, 1024, 768, 390];
export const DEFAULT_WIDTH = 1440;
const VIEW_HEIGHT = 900;
const MAX_HEIGHT = 6000;
const COLOUR_TOLERANCE = 24;
const LAYOUT_TOLERANCE = 12;
const MAX_DIFFS = 80;
const CONTROLS = new Set(["button", "input", "select", "textarea"]);
const KIND_ORDER = ["Missing", "Text", "Colour", "Font", "Size", "Layout", "Extra", "Other"];

const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300);

/** Runs in the page: every visible piece of text with its place and style. Kept as a string so the bundler cannot rewrite it. */
const READ_ELEMENTS = String.raw`(() => {
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
  const out = [];
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
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.opacity === "0") continue;
    out.push({
      text, tag: control ? (control.tagName === "BUTTON" || control.getAttribute("role") === "button" ? "button" : control.tagName.toLowerCase()) : own,
      data: !!el.closest("tbody, [role=gridcell], [role=cell]"),
      x: Math.round(box.left + scrollX), y: Math.round(box.top + scrollY), w: Math.round(box.width), h: Math.round(box.height),
      size: parseFloat(cs.fontSize) || 0, weight: Number(cs.fontWeight) || 400,
      family: (cs.fontFamily.split(",")[0] || "").replace(/["']/g, "").trim(), color: rgb(cs.color), bg: background(el),
    });
    if (out.length >= 2000) break;
  }
  return out;
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

/**
 * Every way the app's page differs from the prototype's, text by text: missing, extra or reworded, and for the same
 * text its colour, background, font, size and place. Places are compared after the page's overall shift, which is
 * reported once, and a change seen on three or more elements is reported once.
 */
export function compareElements(prototype: PageElement[], app: PageElement[]): ScreenDiff[] {
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
  const P = byText(prototype), A = byText(app);
  const pairs: [PageElement, PageElement][] = [];
  let missing: PageElement[] = [], extra: PageElement[] = [];
  for (const [k, ps] of P) {
    const as = A.get(k) ?? [];
    ps.forEach((p, i) => (as[i] ? pairs.push([p, as[i]]) : missing.push(p)));
  }
  for (const [k, as] of A) extra.push(...as.slice((P.get(k) ?? []).length));
  const dx = middle(pairs.map(([p, a]) => a.x - p.x)), dy = middle(pairs.map(([p, a]) => a.y - p.y));
  const at = (e: PageElement) => `${e.tag} at ${e.x},${e.y}`;

  type Row = ScreenDiff & { group?: string; merged?: { prototype: string; build: string } };
  const rows: Row[] = [];
  if (Math.abs(dx) > LAYOUT_TOLERANCE || Math.abs(dy) > LAYOUT_TOLERANCE) rows.push({ kind: "Layout", element: "The whole page", prototype: "as in the prototype", build: `everything moved ${dx}px across and ${dy}px down` });
  // A missing text and an extra one of the same kind in the same place is changed wording.
  for (const p of [...missing]) {
    const a = extra.find((e) => e.tag === p.tag && Math.abs(e.x - p.x - dx) <= 24 && Math.abs(e.y - p.y - dy) <= 24);
    if (!a) continue;
    rows.push({ kind: "Text", element: p.text, prototype: p.text, build: a.text });
    missing = missing.filter((e) => e !== p);
    extra = extra.filter((e) => e !== a);
  }
  for (const p of missing) rows.push({ kind: "Missing", element: p.text, prototype: at(p), build: "" });
  for (const [p, a] of pairs) {
    const style = (kind: string, pv: string, av: string) => rows.push({ kind, element: p.text, prototype: pv, build: av, group: `${kind}|${pv}|${av}` });
    if (colourGap(p.color, a.color) > COLOUR_TOLERANCE) style("Colour", `text ${hex(p.color)}`, `text ${hex(a.color)}`);
    if (colourGap(p.bg, a.bg) > COLOUR_TOLERANCE) style("Colour", `background ${hex(p.bg)}`, `background ${hex(a.bg)}`);
    if (Math.abs(p.size - a.size) >= 1) style("Size", `${p.size}px text`, `${a.size}px text`);
    if (p.weight !== a.weight) style("Font", `weight ${p.weight}`, `weight ${a.weight}`);
    if (fontName(p.family) !== fontName(a.family)) style("Font", p.family || "default font", a.family || "default font");
    if (CONTROLS.has(p.tag) && (Math.abs(p.w - a.w) > 8 || Math.abs(p.h - a.h) > 6)) rows.push({ kind: "Size", element: p.text, prototype: `${p.w}×${p.h}`, build: `${a.w}×${a.h}` });
    const mx = a.x - p.x - dx, my = a.y - p.y - dy;
    if (Math.abs(mx) > LAYOUT_TOLERANCE || Math.abs(my) > LAYOUT_TOLERANCE) {
      rows.push({ kind: "Layout", element: p.text, prototype: `at ${p.x},${p.y}`, build: `at ${a.x},${a.y}`, group: `Layout|${mx}|${my}`, merged: { prototype: "as in the prototype", build: `moved ${mx}px across and ${my}px down` } });
    }
  }
  for (const a of extra) rows.push({ kind: "Extra", element: a.text, prototype: "", build: at(a) });

  const groups = new Map<string, Row[]>();
  for (const r of rows) if (r.group) groups.set(r.group, [...(groups.get(r.group) ?? []), r]);
  const out: ScreenDiff[] = [];
  for (const r of rows) {
    const same = r.group ? groups.get(r.group)! : [];
    if (same.length < 3) out.push({ element: r.element, kind: r.kind, prototype: r.prototype, build: r.build });
    else if (same[0] === r) out.push({ element: names(same.map((x) => x.element)), kind: r.kind, prototype: r.merged?.prototype ?? r.prototype, build: r.merged?.build ?? r.build });
  }
  out.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  return out.length > MAX_DIFFS ? [...out.slice(0, MAX_DIFFS), { element: `${out.length - MAX_DIFFS} more differences`, kind: "Other", prototype: "", build: "" }] : out;
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

async function settle(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.waitForFunction(LOADING_GONE, undefined, { timeout: 20_000 }).catch(() => {});
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

/** A screenshot of the page as it stands. A growing view is first made as tall as the page, so fixed side bars and inner scroll boxes show all of it. */
async function captureView(page: Page, view: View, withElements: boolean): Promise<Capture> {
  await settle(page);
  if (view.grow) {
    let height = view.height;
    // Twice, because a box made taller can show more that loads in.
    for (let i = 0; i < 2; i++) {
      const next = Math.min(MAX_HEIGHT, Math.max(height, await page.evaluate<number>(FULL_HEIGHT)));
      if (next === height) break;
      height = next;
      await page.setViewportSize({ width: view.width, height });
      await page.waitForTimeout(600);
    }
  }
  const shot = await page.screenshot({ animations: "disabled", caret: "hide" });
  const elements = withElements ? await page.evaluate<PageElement[]>(READ_ELEMENTS) : null;
  return { shot: new Uint8Array(shot), elements, url: page.url() };
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
 * drawn by Chrome at the chosen width, and an HTML one also gives its texts and styles.
 */
export async function renderPrototype(browser: Browser, proto: { fileName: string; mimeType: string; bytes: Uint8Array }, width: number): Promise<{ capture: Capture; view: View; rendered: boolean } | { blocked: string }> {
  const kind = kindOf(proto);
  if (kind === "picture") {
    const size = await pictureSize(proto.bytes);
    if (!size) return { blocked: `${proto.fileName} is not a picture that can be read.` };
    // A 2x or 3x export of a design at the chosen width is the same design on a sharper screen.
    const scale = [2, 3].find((s) => size.width === width * s) ?? 1;
    return { capture: { shot: new Uint8Array(proto.bytes), elements: null, url: "" }, view: { width: Math.round(size.width / scale), height: Math.min(MAX_HEIGHT, Math.round(size.height / scale)), scale, grow: false }, rendered: false };
  }
  if (kind !== "html" && kind !== "svg") return { blocked: `A ${kind === "pdf" ? "PDF" : "file of this kind"} cannot be compared pixel by pixel. Upload the screen as PNG, JPG, WEBP or HTML.` };
  const dir = mkdtempSync(path.join(os.tmpdir(), "qa-proto-"));
  const context = await browser.newContext({ viewport: { width, height: VIEW_HEIGHT }, deviceScaleFactor: 1, reducedMotion: "reduce" });
  try {
    const file = path.join(dir, `prototype.${kind}`);
    writeFileSync(file, proto.bytes);
    const page = await context.newPage();
    await page.goto(pathToFileURL(file).href, { waitUntil: "load", timeout: 60_000 });
    const view = { width, height: VIEW_HEIGHT, scale: 1, grow: true };
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
    await passwordField(page).waitFor({ state: "hidden", timeout: 20_000 });
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
        await hit.click();
        await page.waitForLoadState("load").catch(() => {});
        return true;
      }
    }
  }
  return false;
}

/**
 * The app's screen at the prototype's size. Signs in with the test account when a password field shows, keeps that
 * session for the next screens, and finds the screen by its name when no page is given.
 */
export async function captureApp(browser: Browser, opts: { url: string | null; home: string; screen: string; view: View; withElements: boolean; account: Account; session?: Session }): Promise<{ capture: Capture; session: Session } | { blocked: string }> {
  const context = await browser.newContext({ viewport: { width: opts.view.width, height: opts.view.height }, deviceScaleFactor: opts.view.scale, reducedMotion: "reduce", ignoreHTTPSErrors: true, storageState: opts.session });
  try {
    const page = await context.newPage();
    const target = opts.url ?? opts.home;
    const open = async () => {
      try {
        await page.goto(target, { waitUntil: "load", timeout: 45_000 });
        await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
        return null;
      } catch (e) {
        return `Could not open ${target}. ${firstLine(e)}`;
      }
    };
    let problem = await open();
    if (problem) return { blocked: problem };
    if (await passwordField(page).count()) {
      if (!opts.account.user || !opts.account.password) return { blocked: "The app asks to sign in. Save a test account at the top of this step." };
      if (!(await signIn(page, opts.account))) return { blocked: "Signing in with the saved test account did not work: the sign-in page is still showing." };
      problem = await open();
      if (problem) return { blocked: problem };
      if (await passwordField(page).count()) return { blocked: "The app asked to sign in again after signing in with the saved test account." };
    }
    if (!opts.url && !(await findScreen(page, opts.screen))) return { blocked: `No link named like ${opts.screen} was found on ${page.url()}. Type the page for this screen, for example /accounts.` };
    if (new URL(page.url()).origin !== new URL(opts.home).origin) return { blocked: `The page moved to ${new URL(page.url()).origin}, which is not the URL to test.` };
    return { capture: await captureView(page, opts.view, opts.withElements), session: await context.storageState() };
  } finally {
    await context.close().catch(() => {});
  }
}
