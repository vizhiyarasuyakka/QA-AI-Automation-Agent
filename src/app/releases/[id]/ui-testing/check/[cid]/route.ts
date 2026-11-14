import { cachedImage, pictureResponse } from "@/lib/evidence";
import { prisma } from "@/lib/prisma";
import { boxesOf, diffOf } from "@/lib/storychecks";

export const dynamic = "force-dynamic";

/**
 * One user-story check's picture: its own (a validation check after pressing save, or a dropdown while open), else its
 * flow's, with the check boxed (view=evidence) or up close (n=0). Bug drafts link here.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; cid: string }> }) {
  const { id, cid } = await params;
  return cachedImage(req, async () => {
    const c = await prisma.storyCheck.findUnique({ where: { id: cid }, select: { releaseId: true, target: true, kind: true, expect: true, actual: true, box: true, shot: true, flow: { select: { shot: true } } } });
    if (!c || c.releaseId !== id) return new Response("Check not found", { status: 404 });
    const boxes = boxesOf(c.box);
    const picture = c.shot ?? c.flow.shot;
    return pictureResponse(new URL(req.url).searchParams, { prototype: null, build: picture ? new Uint8Array(picture) : null }, [diffOf(c, c.shot ? boxes.own : boxes.flow)]);
  });
}
