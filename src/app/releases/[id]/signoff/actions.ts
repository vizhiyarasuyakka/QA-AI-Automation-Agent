"use server";

import { createHash } from "node:crypto";
import { audit, requireRole } from "@/lib/auth";
import { syncStages } from "@/lib/flows";
import { prisma } from "@/lib/prisma";
import { computeMetrics, evaluateGates } from "@/lib/workflow";
import { redirect } from "next/navigation";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const RECOMMENDATIONS = ["Go", "Go with conditions", "No-go"];

/**
 * The signer is the signed-in QA Lead or Admin, never a typed name. Gates are computed fresh at this moment, and the
 * record carries a SHA-256 of what was signed so a later change to the row can be seen.
 */
export async function saveSignoff(formData: FormData) {
  const releaseId = s(formData, "releaseId");
  const user = await requireRole("QA Lead", "sign off a release");
  const recommendation = s(formData, "recommendation");
  if (!RECOMMENDATIONS.includes(recommendation)) redirect(`/releases/${releaseId}/signoff?err=Choose a recommendation`);
  const metrics = await computeMetrics(releaseId);
  const gates = await evaluateGates(releaseId, metrics);
  if (recommendation === "Go" && !gates[4].met) redirect(`/releases/${releaseId}/signoff?err=${encodeURIComponent("Gate 5 is not met. Choose No-go or Go with conditions and document the risks.")}`);
  if (recommendation === "Go with conditions" && !s(formData, "risks")) redirect(`/releases/${releaseId}/signoff?err=Go with conditions needs the risks and workarounds written down`);

  const signedAt = new Date();
  const record = {
    recommendation, scopeTested: s(formData, "scopeTested"), scopeNotTested: s(formData, "scopeNotTested"), risks: s(formData, "risks"),
    signedBy: `${user.name} <${user.email}>`, signedById: user.id, buildNo: metrics.latestBuild ?? "", metricsJson: JSON.stringify({ metrics, gates }), signedAt,
  };
  const snapshotHash = createHash("sha256").update(JSON.stringify({ releaseId, ...record, signedAt: signedAt.toISOString() })).digest("hex");
  await prisma.signoff.upsert({ where: { releaseId }, update: { ...record, snapshotHash }, create: { releaseId, ...record, snapshotHash } });
  await prisma.release.update({ where: { id: releaseId }, data: { status: recommendation === "No-go" ? "Active" : "Signed off" } });
  await audit(user, "signoff.save", { releaseId, target: recommendation, detail: `build ${record.buildNo || "none"}; Gate 5 ${gates[4].met ? "met" : `not met: ${gates[4].reasons.join("; ")}`}; sha256 ${snapshotHash}` });
  await syncStages(releaseId);
  redirect(`/releases/${releaseId}/signoff?ok=${encodeURIComponent(`Sign-off recorded: ${recommendation}, signed by ${user.name}`)}`);
}
