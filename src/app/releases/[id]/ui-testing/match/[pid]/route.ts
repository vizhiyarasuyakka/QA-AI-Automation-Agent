import { cachedImage, pictureResponse } from "@/lib/evidence";
import { prisma } from "@/lib/prisma";
import type { ScreenDiff } from "@/lib/screencompare";

/**
 * The pictures of a screen's last comparison: the app (default), the prototype as Chrome drew it, or the changed pixels.
 * With n, difference n up close on the prototype or the app. view=evidence is both side by side with every difference
 * boxed and numbered: the evidence a bug draft links to.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; pid: string }> }) {
  const { id, pid } = await params;
  const query = new URL(req.url).searchParams;
  return cachedImage(req, async () => {
    const p = await prisma.prototype.findUnique({ where: { id: pid }, select: { releaseId: true, mimeType: true, matchShot: true, matchProtoShot: true, matchDiffShot: true, matchDiffs: true } });
    if (!p || p.releaseId !== id) return new Response("No screenshot", { status: 404 });
    // A picture prototype is compared as it was uploaded, so its evidence shows the upload.
    const picture = query.get("view") === "evidence" && !p.matchProtoShot && p.mimeType.startsWith("image/") && p.mimeType !== "image/svg+xml";
    const original = picture ? (await prisma.prototype.findUnique({ where: { id: pid }, select: { bytes: true } }))?.bytes ?? null : null;
    return pictureResponse(query, { prototype: p.matchProtoShot ?? original, build: p.matchShot, diff: p.matchDiffShot }, JSON.parse(p.matchDiffs) as ScreenDiff[]);
  });
}
