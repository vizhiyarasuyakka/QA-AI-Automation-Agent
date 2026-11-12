import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/** The HTML report the ZAP baseline scan wrote, for one scan (?scan=id) or the latest. Bug drafts link here. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const wanted = new URL(req.url).searchParams.get("scan");
  const scan = wanted
    ? await prisma.securityScan.findUnique({ where: { id: wanted }, select: { releaseId: true, zapReport: true } })
    : await prisma.securityScan.findFirst({ where: { releaseId: id, NOT: { zapReport: "" } }, orderBy: { startedAt: "desc" }, select: { releaseId: true, zapReport: true } });
  if (!scan || scan.releaseId !== id) return new Response("Scan not found", { status: 404 });
  if (!scan.zapReport) return new Response("This scan has no ZAP report: ZAP did not run, or wrote none.", { status: 404 });
  // ZAP's own report, shown as it is; its scripts are not needed, so it is served without the right to run any.
  return new Response(scan.zapReport, { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:", "X-Frame-Options": "DENY" } });
}
