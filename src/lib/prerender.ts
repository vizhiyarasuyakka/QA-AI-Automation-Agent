import { cachedPicture, pictureKey, pictureRoom, prepareCloseUp } from "./evidence";
import { prisma } from "./prisma";
import type { ScreenDiff } from "./screencompare";

/**
 * Pre-renders the UI Testing page's close-ups. A screen or flow that differs from its prototype opens with every
 * difference shown up close on both sides, which can be thousands of small pictures. Cutting each when the browser
 * first asks for it made them appear only well after scrolling to them. Once the page has been sent, this cuts them
 * in the order the page shows them, reading each screenshot from the database once, and keeps them in the picture
 * cache under the exact address the page links to, so the browser's requests are answered from memory.
 * It stops when the cache is three quarters full, so it never pushes out what it has just cut.
 */
const running = ((globalThis as unknown as { __qaPrerender?: Map<string, { since: number; version: string }> }).__qaPrerender ??= new Map());
const BATCH = 4;

export async function prerenderUiTesting(releaseId: string) {
  const [protos, flows] = await Promise.all([
    prisma.prototype.findMany({ where: { releaseId, matchResult: "Mismatch", NOT: [{ matchShot: null }, { matchProtoShot: null }] }, orderBy: { screen: "asc" }, select: { id: true, matchAt: true, matchDiffs: true } }),
    prisma.uiFlow.findMany({ where: { releaseId, result: "Mismatch", NOT: [{ appShot: null }, { protoShot: null }] }, orderBy: { createdAt: "asc" }, select: { id: true, prototypeId: true, runAt: true, diffs: true } }),
  ]);
  // The same order as the page: each screen, then that screen's flows.
  const order: { kind: "match" | "flow"; id: string; t: number; diffs: ScreenDiff[] }[] = [];
  for (const p of protos) {
    order.push({ kind: "match", id: p.id, t: p.matchAt?.getTime() ?? 0, diffs: JSON.parse(p.matchDiffs) as ScreenDiff[] });
    for (const f of flows.filter((x) => x.prototypeId === p.id)) order.push({ kind: "flow", id: f.id, t: f.runAt?.getTime() ?? 0, diffs: JSON.parse(f.diffs) as ScreenDiff[] });
  }
  for (const f of flows.filter((x) => !protos.some((p) => p.id === x.prototypeId))) order.push({ kind: "flow", id: f.id, t: f.runAt?.getTime() ?? 0, diffs: JSON.parse(f.diffs) as ScreenDiff[] });

  // Already done for these same results, or being done now: nothing to do.
  const version = order.map((o) => `${o.id}:${o.t}`).join(",");
  const was = running.get(releaseId);
  if (was && was.version === version) return 0;
  running.set(releaseId, { since: Date.now(), version });

  let cut = 0;
  for (const o of order) {
    if (!pictureRoom()) break;
    const path = `/releases/${releaseId}/ui-testing/${o.kind}/${o.id}`;
    const wanted = o.diffs.flatMap((_, i) => (["prototype", "app"] as const).map((view) => ({ i, view, key: pictureKey(path, `t=${o.t}&view=${view}&n=${i}`) }))).filter((w) => !cachedPicture(w.key));
    if (!wanted.length) continue;
    // One read of the two screenshots for all of this screen's or flow's close-ups.
    const row = o.kind === "match"
      ? await prisma.prototype.findUnique({ where: { id: o.id }, select: { matchProtoShot: true, matchShot: true } }).then((p) => p && { prototype: p.matchProtoShot, build: p.matchShot })
      : await prisma.uiFlow.findUnique({ where: { id: o.id }, select: { protoShot: true, appShot: true } }).then((f) => f && { prototype: f.protoShot, build: f.appShot });
    if (!row?.prototype || !row.build) continue;
    for (let k = 0; k < wanted.length; k += BATCH) {
      await Promise.all(wanted.slice(k, k + BATCH).map((w) => prepareCloseUp(w.key, w.view === "prototype" ? row.prototype! : row.build!, o.diffs, w.i, w.view === "prototype" ? "prototype" : "build").catch(() => {})));
      cut += Math.min(BATCH, wanted.length - k);
    }
  }
  return cut;
}
