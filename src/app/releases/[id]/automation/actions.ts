"use server";

import { startPlaywright, startScriptRun } from "@/lib/automation";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

export async function triggerScripts(formData: FormData) {
  const releaseId = s(formData, "releaseId");
  const err = await startPlaywright(releaseId);
  const back = `/releases/${releaseId}/automation`;
  if (err) redirect(`${back}?err=${encodeURIComponent(err)}`);
  redirect(`${back}?info=${encodeURIComponent("Script generation started")}`);
}

/** Runs every stored script here, on the URL to test. */
export async function runScripts(formData: FormData) {
  const releaseId = s(formData, "releaseId");
  const err = await startScriptRun(releaseId);
  const back = `/releases/${releaseId}/automation`;
  if (err) redirect(`${back}?err=${encodeURIComponent(err)}`);
  redirect(`${back}?info=${encodeURIComponent("Running the scripts")}`);
}

export async function saveScript(formData: FormData) {
  const id = s(formData, "id"); const releaseId = s(formData, "releaseId");
  await prisma.automationScript.update({ where: { id }, data: { code: String(formData.get("code") ?? ""), edited: true, status: "Unchecked", error: "" } });
  redirect(`/releases/${releaseId}/automation?ok=Script saved`);
}

export async function deleteScript(formData: FormData) {
  const id = s(formData, "id"); const releaseId = s(formData, "releaseId");
  await prisma.automationScript.delete({ where: { id } });
  redirect(`/releases/${releaseId}/automation?ok=Script removed`);
}
