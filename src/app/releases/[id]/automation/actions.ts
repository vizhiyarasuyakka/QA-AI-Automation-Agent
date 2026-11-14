"use server";

import { audit, requireRole } from "@/lib/auth";
import { startPlaywright, startScriptRun } from "@/lib/automation";
import { prisma } from "@/lib/prisma";
import { policyMessage, scriptPolicy } from "@/lib/scriptpolicy";
import { redirect } from "next/navigation";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/** Back to the page, keeping the chosen story open. */
const back = (releaseId: string, story: string, message: string) => `/releases/${releaseId}/automation?${story ? `story=${encodeURIComponent(story)}&` : ""}${message}`;

/** Writes the scripts for every story, or for the one chosen. */
export async function triggerScripts(formData: FormData) {
  const releaseId = s(formData, "releaseId"), story = s(formData, "story");
  const err = await startPlaywright(releaseId, story ? [story] : undefined);
  redirect(back(releaseId, story, err ? `err=${encodeURIComponent(err)}` : `info=${encodeURIComponent(story ? "Writing this story's scripts" : "Script generation started")}`));
}

/** Runs the stored scripts here, on the URL to test: all of them, one story's, or one test case. */
export async function runScripts(formData: FormData) {
  const releaseId = s(formData, "releaseId"), story = s(formData, "story"), tcId = s(formData, "tcId");
  const scope = s(formData, "scope");
  const err = await startScriptRun(releaseId, scope === "case" ? { storyId: story || undefined, tcId } : scope === "story" ? { storyId: story } : {});
  redirect(back(releaseId, story, err ? `err=${encodeURIComponent(err)}` : `info=${encodeURIComponent(scope === "case" ? `Running ${tcId}` : scope === "story" ? "Running this story's scripts" : "Running the scripts")}`));
}

/** Hand-edited code runs on this server, so only a QA Lead or Admin may save it, it is checked first, and the edit is audited. */
export async function saveScript(formData: FormData) {
  const user = await requireRole("QA Lead", "edit Playwright scripts");
  const id = s(formData, "id"); const releaseId = s(formData, "releaseId");
  const code = String(formData.get("code") ?? "");
  const script = await prisma.automationScript.findUnique({ where: { id }, select: { releaseId: true, fileName: true } });
  if (!script || script.releaseId !== releaseId) redirect(`/releases/${releaseId}/automation?err=${encodeURIComponent("That script no longer exists.")}`);
  const policy = await scriptPolicy(code, script.fileName);
  await prisma.automationScript.update({ where: { id }, data: { code, edited: true, editedBy: user.email, status: policy.ok ? "Unchecked" : "Blocked by policy", error: policyMessage(policy) } });
  await audit(user, "script.save", { releaseId, target: script.fileName, detail: `${code.length} characters${policy.ok ? "" : `; ${policyMessage(policy)}`}` });
  redirect(`/releases/${releaseId}/automation?${policy.ok ? `ok=Script saved` : `err=${encodeURIComponent(`Saved, but it will not run. ${policyMessage(policy)}`)}`}`);
}

export async function deleteScript(formData: FormData) {
  const user = await requireRole("QA Lead", "remove Playwright scripts");
  const id = s(formData, "id"); const releaseId = s(formData, "releaseId");
  const script = await prisma.automationScript.delete({ where: { id } });
  await audit(user, "script.delete", { releaseId, target: script.fileName });
  redirect(`/releases/${releaseId}/automation?ok=Script removed`);
}
