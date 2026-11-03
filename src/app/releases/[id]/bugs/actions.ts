"use server";

import { prisma } from "@/lib/prisma";
import { nextBugId } from "@/lib/workflow";
import { logCandidate, draftsFromFailedCases, sendReport } from "@/lib/bugflow";
import { pushBug } from "@/lib/webhook";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

export async function createBug(formData: FormData) {
  const releaseId = s(formData, "releaseId");
  const title = s(formData, "title"), module = s(formData, "module"), severity = s(formData, "severity"), steps = s(formData, "steps"), expected = s(formData, "expected"), actual = s(formData, "actual"), buildNo = s(formData, "buildNo");
  const missing = [["title", title], ["module", module], ["steps to reproduce", steps], ["expected", expected], ["actual", actual], ["build number", buildNo]].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) redirect(`/releases/${releaseId}/bugs?err=${encodeURIComponent("Missing: " + missing.join(", "))}`);
  const reproduced = formData.get("reproducedByHuman") === "on";
  if (!reproduced && severity !== "Low") redirect(`/releases/${releaseId}/bugs?err=${encodeURIComponent("Reproduce the bug yourself before logging; only Low severity may be logged without reproduction")}`);
  const existing = await prisma.bug.findMany({ where: { releaseId }, select: { bugId: true, module: true, title: true } });
  const dup = existing.find((b) => b.module === module && b.title.toLowerCase() === title.toLowerCase());
  if (dup && formData.get("force") !== "on") redirect(`/releases/${releaseId}/bugs?err=${encodeURIComponent(`${dup.bugId} already has the same module and title. Tick "log anyway" if it is a different bug.`)}`);
  const chosenId = s(formData, "bugId");
  if (chosenId && existing.some((b) => b.bugId === chosenId)) redirect(`/releases/${releaseId}/bugs?err=${encodeURIComponent(`${chosenId} already exists. Leave Bug ID blank to get the next number.`)}`);
  const storyRefId = s(formData, "storyRefId") || null;
  const testCaseRefId = s(formData, "testCaseRefId") || null;
  const bug = await prisma.bug.create({
    data: {
      releaseId, bugId: s(formData, "bugId") || nextBugId(existing.map((b) => b.bugId)), title, module, severity, priority: s(formData, "priority") || "P2",
      storyRefId, testCaseRefId, environment: s(formData, "environment") || "QA", buildNo, browser: s(formData, "browser"),
      precondition: s(formData, "precondition"), steps, testData: s(formData, "testData"), expected, actual, evidenceUrl: s(formData, "evidenceUrl"),
      reproducedByHuman: reproduced, workaround: s(formData, "workaround"),
    },
  });
  await pushBug(bug.id);
  const b = await prisma.bug.findUnique({ where: { id: bug.id } });
  redirect(`/releases/${releaseId}/bugs?ok=${encodeURIComponent(`${bug.bugId} logged. Push: ${b?.webhookStatus}`)}`);
}

export async function makeDrafts(formData: FormData) {
  const releaseId = s(formData, "releaseId");
  const n = await draftsFromFailedCases(releaseId);
  redirect(`/releases/${releaseId}/bugs?ok=${encodeURIComponent(n ? `${n} drafts created from failed cases` : "No new failed cases on the latest build")}`);
}

export async function logDraft(formData: FormData) {
  const releaseId = s(formData, "releaseId");
  const res = await logCandidate(s(formData, "id"), s(formData, "severity"), formData.get("reproducedByHuman") === "on");
  redirect(`/releases/${releaseId}/bugs?${res.error ? "err" : "ok"}=${encodeURIComponent(res.error ?? res.message ?? "")}`);
}

export async function dismissDraft(formData: FormData) {
  await prisma.bugCandidate.update({ where: { id: s(formData, "id") }, data: { status: "Dismissed" } });
  redirect(`/releases/${s(formData, "releaseId")}/bugs?ok=Draft dismissed`);
}

export async function sendTestReport(formData: FormData) {
  const releaseId = s(formData, "releaseId");
  const res = await sendReport(releaseId);
  redirect(`/releases/${releaseId}/bugs?${res.error ? "err" : "ok"}=${encodeURIComponent(res.error ?? res.message ?? "")}`);
}

export async function updateBugStatus(formData: FormData) {
  const id = s(formData, "id"); const releaseId = s(formData, "releaseId"); const status = s(formData, "status");
  const bug = await prisma.bug.findUnique({ where: { id } });
  if (!bug) redirect(`/releases/${releaseId}/bugs`);
  const data: { status: string; workaround: string; priority: string; fixedAt?: Date | null; closedAt?: Date | null; reopenCount?: number } = { status, workaround: s(formData, "workaround"), priority: s(formData, "priority") || bug.priority };
  if (status === "Fixed" && !bug.fixedAt) data.fixedAt = new Date();
  if (status === "Closed") { data.closedAt = new Date(); if (!bug.fixedAt) data.fixedAt = new Date(); }
  if (status === "Reopened") { if (bug.status !== "Reopened") data.reopenCount = bug.reopenCount + 1; data.fixedAt = null; data.closedAt = null; }
  if (status === "Open" || status === "In progress") { data.fixedAt = null; data.closedAt = null; }
  await prisma.bug.update({ where: { id }, data });
  revalidatePath(`/releases/${releaseId}/bugs`);
  redirect(`/releases/${releaseId}/bugs?ok=${encodeURIComponent(`${bug.bugId} set to ${status}`)}`);
}

export async function resendWebhook(formData: FormData) {
  const id = s(formData, "id"); const releaseId = s(formData, "releaseId");
  await pushBug(id);
  const b = await prisma.bug.findUnique({ where: { id } });
  redirect(`/releases/${releaseId}/bugs?ok=${encodeURIComponent(`Push ${b?.webhookStatus}: ${b?.webhookResponse.slice(0, 120)}`)}`);
}

export async function deleteBug(formData: FormData) {
  const id = s(formData, "id"); const releaseId = s(formData, "releaseId");
  await prisma.bug.delete({ where: { id } });
  redirect(`/releases/${releaseId}/bugs?ok=Bug deleted`);
}
