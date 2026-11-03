import { prisma } from "@/lib/prisma";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; pid: string }> }) {
  const { id, pid } = await params;
  const p = await prisma.prototype.findUnique({ where: { id: pid } });
  if (!p || p.releaseId !== id) return new Response("Not found", { status: 404 });
  // Uploaded HTML and SVG can hold scripts, so they download instead of running on this origin.
  const inline = p.mimeType.startsWith("image/") && p.mimeType !== "image/svg+xml" || p.mimeType === "application/pdf";
  return new Response(new Uint8Array(p.bytes), { headers: { "Content-Type": inline ? p.mimeType : "application/octet-stream", "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${p.fileName.replace(/[^\w.-]+/g, "_")}"` } });
}
