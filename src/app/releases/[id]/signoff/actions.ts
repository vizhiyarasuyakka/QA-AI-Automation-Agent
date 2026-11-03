"use server";

import { prisma } from "@/lib/prisma";
import { computeMetrics, evaluateGates } from "@/lib/workflow";
import { redirect } from "next/navigation";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

export async function saveSignoff(formData: FormData) {
  const releaseId = s(formData, "releaseId");
  const recommendation = s(formData, "recommendation");
  const signedBy = s(formData, "signedBy");
  if (!signedBy) redirect(`/releases/${releaseId}/signoff?err=Signed by is required`);
  const metrics = await computeMetrics(releaseId);
  const gates = await evaluateGates(releaseId, metrics);
  if (recommendation === "Go" && !gates[4].met) redirect(`/releases/${releaseId}/signoff?err=${encodeURIComponent("Gate 5 is not met. Choose No-go or Go with conditions and document the risks.")}`);
  if (recommendation === "Go with conditions" && !s(formData, "risks")) redirect(`/releases/${releaseId}/signoff?err=Go with conditions needs the risks and workarounds written down`);
  await prisma.signoff.upsert({
    where: { releaseId },
    update: { recommendation, scopeTested: s(formData, "scopeTested"), scopeNotTested: s(formData, "scopeNotTested"), risks: s(formData, "risks"), signedBy, buildNo: metrics.latestBuild ?? "", metricsJson: JSON.stringify({ metrics, gates }), signedAt: new Date() },
    create: { releaseId, recommendation, scopeTested: s(formData, "scopeTested"), scopeNotTested: s(formData, "scopeNotTested"), risks: s(formData, "risks"), signedBy, buildNo: metrics.latestBuild ?? "", metricsJson: JSON.stringify({ metrics, gates }) },
  });
  await prisma.release.update({ where: { id: releaseId }, data: { status: recommendation === "No-go" ? "Active" : "Signed off" } });
  redirect(`/releases/${releaseId}/signoff?ok=${encodeURIComponent(`Sign-off recorded: ${recommendation}`)}`);
}
