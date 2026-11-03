"use server";

import { syncStages } from "@/lib/flows";
import { prisma } from "@/lib/prisma";
import { setTestUrl } from "@/lib/testurl";
import { saveMatch, startTriggerSearch, startUiMatch, startUiRun } from "@/lib/uitesting";
import { redirect } from "next/navigation";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
/** The sign-in typed under the URL, when the form has one. The password is not trimmed: spaces can be part of it. */
const loginOf = (fd: FormData) => (fd.has("loginUser") ? { user: s(fd, "loginUser"), password: String(fd.get("loginPassword") ?? "") } : undefined);
const NO_URL = "Enter the URL to test at the top of this step first.";
const latestBuild = (releaseId: string) => prisma.build.findFirst({ where: { releaseId }, orderBy: { deployedAt: "desc" } });

/** The URL to test and its sign-in. Step 4 uses the same ones. */
export async function saveUiTarget(formData: FormData) {
  const releaseId = s(formData, "releaseId");
  const target = await setTestUrl(releaseId, s(formData, "url"), loginOf(formData));
  await syncStages(releaseId);
  redirect(`/releases/${releaseId}/ui-testing?${"error" in target ? `err=${encodeURIComponent(target.error)}` : "ok=URL saved"}`);
}

/** Stage 5's trigger: one screen, all of them, or those that do not match yet. Page addresses are saved first, so what is typed on the row is what gets compared. */
export async function compareScreens(formData: FormData) {
  const releaseId = s(formData, "releaseId");
  const back = `/releases/${releaseId}/ui-testing`;
  const protos = await prisma.prototype.findMany({ where: { releaseId }, select: { id: true, pagePath: true, matchResult: true } });
  for (const p of protos) {
    const typed = formData.get(`path:${p.id}`);
    if (typeof typed === "string" && typed.trim() !== p.pagePath) await prisma.prototype.update({ where: { id: p.id }, data: { pagePath: typed.trim() } });
  }
  if (formData.get("save") !== null) redirect(`${back}?ok=Pages saved`);
  const build = await latestBuild(releaseId);
  if (!build?.envUrl) redirect(`${back}?err=${encodeURIComponent(NO_URL)}`);
  const one = s(formData, "screen");
  const ids = one ? [one] : s(formData, "scope") === "open" ? protos.filter((p) => p.matchResult !== "Match").map((p) => p.id) : undefined;
  if (ids && !ids.length) redirect(`${back}?err=${encodeURIComponent("Every screen matches already.")}`);
  const err = await startUiMatch(releaseId, build.id, ids, Number(s(formData, "width")) || undefined);
  redirect(err ? `${back}?err=${encodeURIComponent(err)}` : `${back}?info=${encodeURIComponent("Comparison started")}`);
}

/** A person's own look at one screen. Not matching becomes a bug draft, as a comparison would. */
export async function markScreen(formData: FormData) {
  const releaseId = s(formData, "releaseId"); const id = s(formData, "screen");
  const back = `/releases/${releaseId}/ui-testing`;
  const build = await latestBuild(releaseId);
  if (!build?.envUrl) redirect(`${back}?err=${encodeURIComponent(NO_URL)}`);
  const p = await prisma.prototype.findUnique({ where: { id } });
  if (!p || p.releaseId !== releaseId) redirect(`${back}?err=${encodeURIComponent("Screen not found.")}`);
  const result = s(formData, `mark:${id}`);
  if (!["Match", "Mismatch", "Blocked"].includes(result)) redirect(`${back}?err=${encodeURIComponent("Choose Match, Mismatch or Blocked.")}`);
  await saveMatch(p, build, { result, url: "", summary: "Checked by hand.", differences: [] }, null, null, true);
  await syncStages(releaseId);
  redirect(`${back}?ok=${encodeURIComponent(`${p.screen} marked ${result}`)}`);
}

export async function findTriggers(formData: FormData) {
  const releaseId = s(formData, "releaseId");
  const err = await startTriggerSearch(releaseId);
  const back = `/releases/${releaseId}/ui-testing`;
  redirect(err ? `${back}?err=${encodeURIComponent(err)}` : `${back}?info=${encodeURIComponent("Finding triggers")}`);
}

export async function runUiTest(formData: FormData) {
  const releaseId = s(formData, "releaseId");
  const back = `/releases/${releaseId}/ui-testing`;
  const build = await latestBuild(releaseId);
  if (!build?.envUrl) redirect(`${back}?err=${encodeURIComponent(NO_URL)}`);
  const err = await startUiRun(releaseId, build.id, s(formData, "scope") === "all" ? "all" : "notrun");
  redirect(err ? `${back}?err=${encodeURIComponent(err)}` : `${back}?info=${encodeURIComponent("UI test started")}`);
}

export async function deleteTrigger(formData: FormData) {
  const releaseId = s(formData, "releaseId");
  await prisma.uiTrigger.delete({ where: { id: s(formData, "id") } });
  await syncStages(releaseId);
  redirect(`/releases/${releaseId}/ui-testing?ok=Trigger removed`);
}
