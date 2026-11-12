import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/** The screen at the end of a test case's Playwright run, as a PNG. Bug drafts link here. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; eid: string }> }) {
  const { id, eid } = await params;
  const e = await prisma.execution.findUnique({ where: { id: eid }, select: { shot: true, build: { select: { releaseId: true } } } });
  if (!e || e.build.releaseId !== id) return new Response("Not found", { status: 404 });
  if (!e.shot) return new Response("This case has no screenshot: it has not run here yet.", { status: 404 });
  return new Response(new Uint8Array(e.shot), { headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=60" } });
}
