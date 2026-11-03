import { prisma } from "@/lib/prisma";

/** The pictures of a screen's last comparison: the app (default), the prototype as Chrome drew it, or the changed pixels. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; pid: string }> }) {
  const { id, pid } = await params;
  const view = new URL(req.url).searchParams.get("view");
  const p = await prisma.prototype.findUnique({ where: { id: pid }, select: { releaseId: true, matchShot: true, matchProtoShot: true, matchDiffShot: true } });
  const bytes = view === "prototype" ? p?.matchProtoShot : view === "diff" ? p?.matchDiffShot : p?.matchShot;
  if (!p || p.releaseId !== id || !bytes) return new Response("No screenshot", { status: 404 });
  return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } });
}
