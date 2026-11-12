"use server";

import { syncStages } from "@/lib/flows";
import { prisma } from "@/lib/prisma";
import { startSecurityScan } from "@/lib/security";
import { redirect } from "next/navigation";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
function back(releaseId: string, q: string): never {
  return redirect(`/releases/${releaseId}/security?${q}`);
}

/** Starts the scan: the built-in checks, the ZAP baseline scan, or both. */
export async function runSecurityScan(formData: FormData) {
  const releaseId = s(formData, "releaseId");
  const err = await startSecurityScan(releaseId, { builtIn: formData.get("builtIn") === "on", zap: formData.get("zap") === "on" });
  back(releaseId, err ? `err=${encodeURIComponent(err)}` : `info=${encodeURIComponent("Security scan started")}`);
}

/** Forgets one scan and, when it was the last, the drafts the scans made that nobody has acted on. */
export async function removeScan(formData: FormData) {
  const releaseId = s(formData, "releaseId"), id = s(formData, "scan");
  const scan = await prisma.securityScan.findUnique({ where: { id }, select: { releaseId: true } });
  if (!scan || scan.releaseId !== releaseId) back(releaseId, `err=${encodeURIComponent("Scan not found.")}`);
  await prisma.securityScan.delete({ where: { id } });
  if (!(await prisma.securityScan.count({ where: { releaseId } }))) await prisma.bugCandidate.deleteMany({ where: { releaseId, status: "Pending", refKey: { startsWith: "sec:" } } });
  await syncStages(releaseId);
  back(releaseId, `ok=${encodeURIComponent("Scan removed")}`);
}
