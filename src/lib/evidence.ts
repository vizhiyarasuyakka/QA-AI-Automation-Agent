import sharp from "sharp";
import type { Box, ScreenDiff } from "./screencompare";

export type Side = "prototype" | "build";

const RED = "#e11d48";
const FONT = "Arial, Helvetica, sans-serif";
/** Room kept around a difference in its close-up, and the smallest close-up, so what is around it shows too. */
const PAD = 56;
const MIN_CROP = { w: 420, h: 220 };
const HEAD = 56;
const GUTTER = 24;
const NOTE = "Numbers match the list of differences. A dashed box marks where an element is absent.";

type Mark = { box: Box; n: number; dashed: boolean };

/** The side an element is not on, where its box only marks the place it would take. */
const absentOn = (kind: string): Side | null => (kind.startsWith("Missing") ? "build" : kind.startsWith("Extra") ? "prototype" : null);

const within = (v: number, low: number, high: number) => Math.max(low, Math.min(high, v));

/**
 * The boxes of the differences on one side's screenshot. A dashed box past the end of a shorter page is drawn at its
 * edge: the element is absent, and the edge shows where the page stops without it.
 */
const marksOn = (diffs: ScreenDiff[], side: Side, size: { width: number; height: number }, only?: number): Mark[] =>
  diffs.flatMap((d, i) => (only === undefined || only === i ? (d.at?.[side] ?? []).map((box) => {
    const dashed = absentOn(d.kind) === side;
    const fitted = dashed ? { ...box, x: within(box.x, 0, size.width - box.w), y: within(box.y, 0, size.height - box.h) } : box;
    return { box: fitted, n: i + 1, dashed };
  }) : []));

/**
 * Red boxes, each with its number on a tab over its top right corner, where a label rarely is, or below the box at the
 * top edge. An absent element's box is dashed, lightly filled and tabbed "not here".
 */
function drawn(width: number, height: number, marks: Mark[], left = 0, top = 0): Buffer {
  const tabs: { x: number; y: number; w: number }[] = [];
  const parts = marks.map(({ box, n, dashed }) => {
    const x = box.x - left - 3, y = box.y - top - 3, w = box.w + 6, h = box.h + 6;
    const tag = dashed ? `${n} not here` : String(n);
    const tw = 12 + tag.length * 8, ty = y >= 22 ? y - 22 : y + h;
    let tx = w >= tw ? x + w - tw : x;
    // Two boxes sharing a corner would hide each other's number: the later tab steps left.
    const clash = () => tabs.find((t) => Math.abs(t.y - ty) < 22 && tx < t.x + t.w && t.x < tx + tw);
    for (let hit = clash(); hit; hit = clash()) tx = hit.x - tw - 2;
    tabs.push({ x: tx, y: ty, w: tw });
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" stroke="${RED}" stroke-width="3"${dashed ? ` stroke-dasharray="9 6" fill="${RED}" fill-opacity="0.12"` : ' fill="none"'}/>`
      + `<rect x="${tx}" y="${ty}" width="${tw}" height="22" fill="${RED}"/>`
      + `<text x="${tx + tw / 2}" y="${ty + 16}" font-family="${FONT}" font-size="14" font-weight="700" fill="#ffffff" text-anchor="middle">${tag}</text>`;
  });
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join("")}</svg>`);
}

/**
 * One difference up close on one side: the area around it with its box drawn, or null when it has no place on that
 * screenshot. On the side where the element is absent, the dashed box shows the place it would take.
 */
export async function evidenceCrop(shot: Uint8Array, diffs: ScreenDiff[], index: number, side: Side): Promise<Uint8Array<ArrayBuffer> | null> {
  const { width = 0, height = 0 } = await sharp(shot).metadata();
  const marks = marksOn(diffs, side, { width, height }, index);
  if (!marks.length || !width || !height) return null;
  const x1 = Math.min(...marks.map((m) => m.box.x)), y1 = Math.min(...marks.map((m) => m.box.y));
  const x2 = Math.max(...marks.map((m) => m.box.x + m.box.w)), y2 = Math.max(...marks.map((m) => m.box.y + m.box.h));
  if (x1 >= width || y1 >= height || x2 <= 0 || y2 <= 0) return null;
  const w = Math.min(width, Math.max(MIN_CROP.w, x2 - x1 + PAD * 2)), h = Math.min(height, Math.max(MIN_CROP.h, y2 - y1 + PAD * 2));
  const left = Math.round(Math.max(0, Math.min(width - w, (x1 + x2 - w) / 2))), top = Math.round(Math.max(0, Math.min(height - h, (y1 + y2 - h) / 2)));
  // One pass (sharp composites after the extract) and WebP: a page can hold thousands of these close-ups, and
  // WebP is several times smaller than PNG and quicker to make. The full evidence sheet stays PNG.
  return new Uint8Array(await sharp(shot).extract({ left, top, width: w, height: h }).composite([{ input: drawn(w, h, marks, left, top) }]).webp({ quality: 88, effort: 2 }).toBuffer());
}

const png = (bytes: Uint8Array) => new Response(new Uint8Array(bytes), { headers: { "Content-Type": "image/png", "Cache-Control": "private, no-cache" } });

/* ---------- picture cache ---------- */

/** Pages link pictures with ?t=<time of the run>, so a URL always means the same picture: safe to keep. */
const VERSIONED = "private, max-age=31536000, immutable";
const MAX_CACHE_BYTES = 128 * 1024 * 1024;
type Cached = { bytes: Uint8Array<ArrayBuffer>; type: string };
const pictures = ((globalThis as unknown as { __qaPictures?: { map: Map<string, Cached>; bytes: number } }).__qaPictures ??= { map: new Map(), bytes: 0 });

function remember(key: string, value: Cached) {
  if (value.bytes.length > MAX_CACHE_BYTES / 8) return;
  pictures.map.set(key, value);
  pictures.bytes += value.bytes.length;
  // Oldest first out: a Map keeps insertion order, and a hit is re-inserted at the end.
  for (const [k, v] of pictures.map) {
    if (pictures.bytes <= MAX_CACHE_BYTES) break;
    pictures.map.delete(k);
    pictures.bytes -= v.bytes.length;
  }
}

/**
 * Wraps a picture route. A page of results can link thousands of close-ups of the same few screenshots; with a
 * version in the URL, each is cut once, kept here (up to 128 MB, least recently used out) and kept by the browser,
 * so scrolling and opening the page again need no database read or image work. The route's own access check runs
 * before anything is stored, and the key is the full path, so a picture is only ever served for the path it was cut for.
 */
export async function cachedImage(req: Request, produce: () => Promise<Response>): Promise<Response> {
  const url = new URL(req.url);
  if (!url.searchParams.has("t")) return produce();
  const key = pictureKey(url.pathname, url.searchParams.toString());
  const send = (c: Cached) => new Response(c.bytes, { headers: { "Content-Type": c.type, "Cache-Control": VERSIONED } });
  const hit = cachedPicture(key) ?? (await inflight.get(key));
  if (hit) return send(hit);
  const res = await produce();
  if (!res.ok) return res;
  const made: Cached = { type: res.headers.get("Content-Type") ?? "image/png", bytes: new Uint8Array(await res.arrayBuffer()) };
  remember(key, made);
  return send(made);
}

/* Used by the pre-render in src/lib/prerender.ts, which cuts a page's close-ups before they are asked for. */

export const pictureKey = (pathname: string, query: string) => `${pathname}?${query}`;

export function cachedPicture(key: string): Cached | null {
  const hit = pictures.map.get(key);
  if (!hit) return null;
  pictures.map.delete(key);
  pictures.map.set(key, hit);
  return hit;
}

/** A picture being cut right now: a request for it waits for that cut instead of cutting it a second time. */
const inflight = ((globalThis as unknown as { __qaPictureInflight?: Map<string, Promise<Cached | null>> }).__qaPictureInflight ??= new Map());

export async function prepareCloseUp(key: string, shot: Uint8Array, diffs: ScreenDiff[], index: number, side: Side): Promise<void> {
  if (pictures.map.has(key) || inflight.has(key)) return;
  const job = evidenceCrop(shot, diffs, index, side).then((bytes) => (bytes ? { bytes, type: "image/webp" } : null));
  inflight.set(key, job);
  try {
    const made = await job;
    if (made) remember(key, made);
  } finally {
    inflight.delete(key);
  }
}

/** True while the cache has room for more pre-cut pictures without pushing out ones already cut. */
export const pictureRoom = () => pictures.bytes < MAX_CACHE_BYTES * 0.75;
const none = (why = "No screenshot") => new Response(why, { status: 404 });

/**
 * Answers a request for a comparison's pictures. view=app (the default), prototype or diff gives that picture; with n,
 * difference n up close on the prototype or the app; view=evidence gives both side by side with every difference
 * boxed and numbered.
 */
export async function pictureResponse(query: URLSearchParams, pictures: { prototype: Uint8Array | null; build: Uint8Array | null; diff?: Uint8Array | null }, diffs: ScreenDiff[]): Promise<Response> {
  const view = query.get("view"), n = query.get("n");
  if (view === "evidence") return pictures.build ? png(await evidenceSheet(pictures.prototype, pictures.build, diffs)) : none();
  const bytes = view === "prototype" ? pictures.prototype : view === "diff" ? pictures.diff : pictures.build;
  if (!bytes) return none();
  if (n === null || view === "diff") return png(bytes);
  const crop = await evidenceCrop(bytes, diffs, Number(n), view === "prototype" ? "prototype" : "build");
  return crop ? new Response(crop, { headers: { "Content-Type": "image/webp", "Cache-Control": "private, no-cache" } }) : none("This difference has no place on this screenshot");
}

/**
 * A whole screen's evidence: the prototype and the build side by side, every difference boxed and numbered as in the
 * list of differences. Without a prototype picture, the build alone.
 */
export async function evidenceSheet(prototype: Uint8Array | null, build: Uint8Array, diffs: ScreenDiff[]): Promise<Uint8Array<ArrayBuffer>> {
  const pane = async (shot: Uint8Array, side: Side, title: string) => {
    const { width = 0, height = 0 } = await sharp(shot).metadata();
    const marks = marksOn(diffs, side, { width, height });
    const input = await (marks.length ? sharp(shot).composite([{ input: drawn(width, height, marks) }]) : sharp(shot)).png().toBuffer();
    return { input, width, height, title };
  };
  const panes = await Promise.all([...(prototype ? [pane(prototype, "prototype", "Prototype")] : []), pane(build, "build", "Build")]);
  const width = panes.reduce((sum, p) => sum + p.width, 0) + GUTTER * (panes.length - 1);
  const height = HEAD + Math.max(...panes.map((p) => p.height));
  const lefts = panes.map((_, i) => panes.slice(0, i).reduce((sum, p) => sum + p.width + GUTTER, 0));
  const frame = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + panes.map((p, i) => `<text x="${lefts[i] + 4}" y="36" font-family="${FONT}" font-size="24" font-weight="700" fill="#111111">${p.title}</text>`).join("")
    + lefts.slice(1).map((x) => `<rect x="${x - GUTTER / 2 - 1}" y="0" width="2" height="${height}" fill="#d1d5db"/>`).join("")
    + `<text x="${width - 8}" y="36" font-family="${FONT}" font-size="16" fill="#555555" text-anchor="end">${NOTE}</text></svg>`);
  const sheet = sharp({ create: { width, height, channels: 4, background: "#ffffff" } })
    .composite([...panes.map((p, i) => ({ input: p.input, left: lefts[i], top: HEAD })), { input: frame, left: 0, top: 0 }]);
  return new Uint8Array(await sheet.png().toBuffer());
}
