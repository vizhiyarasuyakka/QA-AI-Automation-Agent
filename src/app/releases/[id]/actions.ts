"use server";

import { audit, requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { evaluateGates, gateForStage } from "@/lib/workflow";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

/** Stages 1 to 12 follow their pages and the gates; only stage 13 (post-release monitoring) is set by a person. */
const MANUAL_STAGES = new Set([13]);

export async function setStageStatus(formData: FormData) {
  const releaseId = String(formData.get("releaseId"));
  const stageNo = Number(formData.get("stageNo"));
  const status = String(formData.get("status"));
  const note = String(formData.get("note") ?? "");
  if (!MANUAL_STAGES.has(stageNo)) redirect(`/releases/${releaseId}?err=${encodeURIComponent(`Stage ${stageNo} follows its page and cannot be set by hand.`)}`);
  if (!["Pending", "In progress", "Done", "Failed"].includes(status)) redirect(`/releases/${releaseId}?err=${encodeURIComponent("Choose a status.")}`);
  const user = await requireRole("QA Engineer", "update a stage");
  const gateNo = gateForStage(stageNo);
  if (status === "Done" && gateNo) {
    const gate = (await evaluateGates(releaseId))[gateNo - 1];
    if (!gate.met) redirect(`/releases/${releaseId}?err=${encodeURIComponent(`Stage ${stageNo} cannot be Done: Gate ${gateNo} is not met (${gate.reasons.slice(0, 2).join("; ")}).`)}`);
  }
  await audit(user, "stage.set", { releaseId, target: `stage ${stageNo}`, detail: `${status}${note ? `: ${note}` : ""}` });
  await prisma.stageStatus.upsert({
    where: { releaseId_stageNo: { releaseId, stageNo } },
    update: { status, note },
    create: { releaseId, stageNo, status, note },
  });
  revalidatePath(`/releases/${releaseId}`);
  redirect(`/releases/${releaseId}`);
}

export async function addEscape(formData: FormData) {
  const releaseId = String(formData.get("releaseId"));
  const data = {
    releaseId,
    escapeId: String(formData.get("escapeId") ?? "").trim(),
    module: String(formData.get("module") ?? "").trim(),
    severity: String(formData.get("severity") ?? "Medium"),
    stageMissed: String(formData.get("stageMissed") ?? ""),
    description: String(formData.get("description") ?? ""),
  };
  if (!data.escapeId || !data.module) redirect(`/releases/${releaseId}/signoff?err=Escape ID and module are required`);
  await prisma.escape.create({ data });
  revalidatePath(`/releases/${releaseId}/signoff`);
  redirect(`/releases/${releaseId}/signoff?ok=Escape logged. Add a test case for it in the story.`);
}

export async function toggleEscapeTest(formData: FormData) {
  const id = String(formData.get("id"));
  const releaseId = String(formData.get("releaseId"));
  const e = await prisma.escape.findUnique({ where: { id } });
  if (e) await prisma.escape.update({ where: { id }, data: { testAdded: !e.testAdded } });
  revalidatePath(`/releases/${releaseId}/signoff`);
}
