import { prisma } from "@/lib/prisma";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; tid: string }> }) {
  const { id, tid } = await params;
  const t = await prisma.uiTrigger.findUnique({ where: { id: tid }, select: { releaseId: true, screenshot: true } });
  if (!t || t.releaseId !== id || !t.screenshot) return new Response("No screenshot", { status: 404 });
  return new Response(new Uint8Array(t.screenshot), { headers: { "Content-Type": "image/png" } });
}
