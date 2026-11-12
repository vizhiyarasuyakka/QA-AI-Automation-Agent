import { pictureResponse } from "@/lib/evidence";
import { prisma } from "@/lib/prisma";
import type { ScreenDiff } from "@/lib/screencompare";

/**
 * The pictures of a flow's last comparison: the prototype and the app after the flow's clicks. With n, difference n up
 * close; view=evidence is both side by side with every difference boxed and numbered, the evidence its bug draft links to.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; fid: string }> }) {
  const { id, fid } = await params;
  const f = await prisma.uiFlow.findUnique({ where: { id: fid }, select: { releaseId: true, protoShot: true, appShot: true, diffs: true } });
  if (!f || f.releaseId !== id) return new Response("No screenshot", { status: 404 });
  return pictureResponse(new URL(req.url).searchParams, { prototype: f.protoShot, build: f.appShot }, JSON.parse(f.diffs) as ScreenDiff[]);
}
