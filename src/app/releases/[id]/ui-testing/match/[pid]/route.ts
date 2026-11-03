import { evidenceCrop, evidenceSheet } from "@/lib/evidence";
import { prisma } from "@/lib/prisma";
import type { ScreenDiff } from "@/lib/screencompare";

const png = (bytes: Uint8Array) => new Response(new Uint8Array(bytes), { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } });
const none = (why = "No screenshot") => new Response(why, { status: 404 });

/**
 * The pictures of a screen's last comparison: the app (default), the prototype as Chrome drew it, or the changed pixels.
 * With n, difference n up close on the prototype or the app. view=evidence is both side by side with every difference
 * boxed and numbered: the evidence a bug draft links to.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; pid: string }> }) {
  const { id, pid } = await params;
  const query = new URL(req.url).searchParams;
  const view = query.get("view"), n = query.get("n");
  const p = await prisma.prototype.findUnique({ where: { id: pid }, select: { releaseId: true, mimeType: true, matchShot: true, matchProtoShot: true, matchDiffShot: true, matchDiffs: true } });
  if (!p || p.releaseId !== id) return none();
  const diffs = JSON.parse(p.matchDiffs) as ScreenDiff[];
  if (view === "evidence") {
    if (!p.matchShot) return none();
    // A picture prototype is compared as it was uploaded.
    const picture = !p.matchProtoShot && p.mimeType.startsWith("image/") && p.mimeType !== "image/svg+xml";
    const original = picture ? (await prisma.prototype.findUnique({ where: { id: pid }, select: { bytes: true } }))?.bytes : null;
    return png(await evidenceSheet(p.matchProtoShot ?? original ?? null, p.matchShot, diffs));
  }
  const bytes = view === "prototype" ? p.matchProtoShot : view === "diff" ? p.matchDiffShot : p.matchShot;
  if (!bytes) return none();
  if (n === null || view === "diff") return png(bytes);
  const crop = await evidenceCrop(bytes, diffs, Number(n), view === "prototype" ? "prototype" : "build");
  return crop ? png(crop) : none("This difference has no place on this screenshot");
}
