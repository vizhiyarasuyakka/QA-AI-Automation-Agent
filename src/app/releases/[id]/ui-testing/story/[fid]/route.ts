import { cachedImage, pictureResponse } from "@/lib/evidence";
import { prisma } from "@/lib/prisma";
import { boxesOf, diffOf } from "@/lib/storychecks";

export const dynamic = "force-dynamic";

/**
 * A user-story flow's pictures: the build after its steps (the default), one failed check up close (n, counted from 0
 * among the failed ones), or every failed check boxed and numbered (view=evidence). Bug drafts link here.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; fid: string }> }) {
  const { id, fid } = await params;
  return cachedImage(req, async () => {
    const f = await prisma.storyFlow.findUnique({ where: { id: fid }, select: { releaseId: true, shot: true, checks: { where: { result: "Fail" }, orderBy: { no: "asc" }, select: { target: true, kind: true, expect: true, actual: true, box: true } } } });
    if (!f || f.releaseId !== id) return new Response("Flow not found", { status: 404 });
    const diffs = f.checks.map((c) => diffOf(c, boxesOf(c.box).flow));
    return pictureResponse(new URL(req.url).searchParams, { prototype: null, build: f.shot ? new Uint8Array(f.shot) : null }, diffs);
  });
}
