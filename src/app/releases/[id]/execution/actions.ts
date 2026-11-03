"use server";

import { saveCriterionResult, startChromeRun, startCriteriaRun } from "@/lib/automation";
import { parseCriteria } from "@/lib/coverage";
import { criteriaToRun } from "@/lib/execview";
import { fetchStoryCriteria } from "@/lib/generation";
import { syncStages } from "@/lib/flows";
import { prisma } from "@/lib/prisma";
import { setTestUrl } from "@/lib/testurl";
import { evaluateGates } from "@/lib/workflow";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
/** The sign-in typed under the URL, when the form has one. The password is not trimmed: spaces can be part of it. */
const loginOf = (fd: FormData) => (fd.has("loginUser") ? { user: s(fd, "loginUser"), password: String(fd.get("loginPassword") ?? "") } : undefined);

async function runInChrome(formData: FormData, field: "execId" | "shownId") {
  const releaseId = s(formData, "releaseId"); const buildId = s(formData, "buildId");
  const err = await startChromeRun(releaseId, buildId, formData.getAll(field).map(String));
  const back = `/releases/${releaseId}/execution?build=${buildId}`;
  if (err) redirect(`${back}&err=${encodeURIComponent(err)}`);
  redirect(`${back}&ok=${encodeURIComponent("Chrome run started")}`);
}

/** Stage 4's trigger for one story: one acceptance criterion or all of its criteria, on the URL saved above. No test case is involved. */
export async function testCriteriaInChrome(formData: FormData) {
  const releaseId = s(formData, "releaseId"); const storyId = s(formData, "storyId");
  const back = `/releases/${releaseId}/execution?story=${storyId}`;
  const typed = s(formData, "url");
  const target = typed ? await setTestUrl(releaseId, typed, loginOf(formData)) : null;
  if (target && "error" in target) redirect(`${back}&err=${encodeURIComponent(target.error)}`);
  const build = await prisma.build.findFirst({ where: { releaseId }, orderBy: { deployedAt: "desc" } });
  if (!build?.envUrl) redirect(`${back}&err=${encodeURIComponent("Enter the URL to test above and save it first.")}`);
  const story = await prisma.story.findUnique({ where: { id: storyId }, select: { releaseId: true, acceptanceCriteria: true } });
  if (!story || story.releaseId !== releaseId) redirect(`${back}&err=${encodeURIComponent("Story not found.")}`);
  const all = formData.get("all") !== null;
  const criteria = criteriaToRun(all, story.acceptanceCriteria, formData.getAll("criterion").map(String));
  if (!criteria.length) redirect(`${back}&err=${encodeURIComponent("This story has no acceptance criteria yet. Fetch them first.")}`);
  const err = await startCriteriaRun(releaseId, build.id, [{ storyId, criteria }]);
  if (err) redirect(`${back}&err=${encodeURIComponent(err)}`);
  redirect(`${back}&ok=${encodeURIComponent(`Chrome is opening ${build.envUrl} and checking ${all ? `all ${criteria.length} acceptance criteria` : criteria.join(", ")}`)}`);
}

/** Every acceptance criterion of every story in one run, or only those that have not passed yet, so a stopped run can carry on. */
export async function runAllCriteria(formData: FormData) {
  const releaseId = s(formData, "releaseId"); const story = s(formData, "storyId");
  const back = `/releases/${releaseId}/execution${story ? `?story=${story}` : ""}`;
  const sep = back.includes("?") ? "&" : "?";
  const target = await setTestUrl(releaseId, s(formData, "url"), loginOf(formData));
  if ("error" in target) redirect(`${back}${sep}err=${encodeURIComponent(target.error)}`);
  const onlyOpen = s(formData, "scope") === "open";
  const stories = await prisma.story.findMany({ where: { releaseId }, orderBy: [{ module: "asc" }, { storyId: "asc" }], select: { id: true, acceptanceCriteria: true } });
  const passed = onlyOpen ? await prisma.criterionResult.findMany({ where: { buildId: target.build.id, result: "Pass" }, select: { storyId: true, criterion: true } }) : [];
  const picks = stories
    .map((st) => ({ storyId: st.id, criteria: parseCriteria(st.acceptanceCriteria).map((c) => c.id).filter((ac) => !passed.some((p) => p.storyId === st.id && p.criterion === ac)) }))
    .filter((p) => p.criteria.length);
  if (!picks.length) redirect(`${back}${sep}err=${encodeURIComponent(onlyOpen ? "Every acceptance criterion has passed already." : "No user story has acceptance criteria yet.")}`);
  const count = picks.reduce((a, p) => a + p.criteria.length, 0);
  const err = await startCriteriaRun(releaseId, target.build.id, picks);
  if (err) redirect(`${back}${sep}err=${encodeURIComponent(err)}`);
  redirect(`${back}${sep}ok=${encodeURIComponent(`Checking ${count} acceptance criteria of ${picks.length} ${picks.length === 1 ? "story" : "stories"} on ${target.build.envUrl}`)}`);
}

/** A person's own check of one criterion. The URL is kept when typed, so a result is always tied to the site it was seen on. */
export async function recordCriterion(formData: FormData) {
  const releaseId = s(formData, "releaseId"); const storyId = s(formData, "storyId"); const criterion = s(formData, "criterion").toUpperCase();
  const back = `/releases/${releaseId}/execution?story=${storyId}`;
  if (s(formData, "url")) {
    const target = await setTestUrl(releaseId, s(formData, "url"), loginOf(formData));
    if ("error" in target) redirect(`${back}&err=${encodeURIComponent(target.error)}`);
  }
  const build = await prisma.build.findFirst({ where: { releaseId }, orderBy: { deployedAt: "desc" } });
  if (!build) redirect(`${back}&err=${encodeURIComponent("Enter the URL to test first.")}`);
  const story = await prisma.story.findUnique({ where: { id: storyId } });
  if (!story || story.releaseId !== releaseId) redirect(`${back}&err=${encodeURIComponent("Story not found.")}`);
  const ac = parseCriteria(story.acceptanceCriteria).find((c) => c.id === criterion);
  if (!ac) redirect(`${back}&err=${encodeURIComponent("That criterion is not on this story.")}`);
  const result = s(formData, `result:${criterion}`);
  if (!["Pass", "Fail", "Blocked"].includes(result)) redirect(`${back}&err=${encodeURIComponent("Choose Pass, Fail or Blocked.")}`);
  await saveCriterionResult({ releaseId, buildId: build.id, buildNo: build.number, envUrl: build.envUrl, storyId, storyCode: story.storyId, module: story.module, criterion: ac.id, text: ac.text, result, actual: "Checked by hand.", executedBy: "Human" });
  await syncStages(releaseId);
  redirect(`${back}&ok=${encodeURIComponent(`${ac.id} marked ${result}`)}`);
}

/** Criteria typed in step 4, one per line, numbered after the story's last one. A typed AC number is dropped, so numbers never clash. */
export async function addCriteria(formData: FormData) {
  const releaseId = s(formData, "releaseId"); const storyId = s(formData, "storyId");
  const back = `/releases/${releaseId}/execution?story=${storyId}`;
  const story = await prisma.story.findUnique({ where: { id: storyId } });
  if (!story || story.releaseId !== releaseId) redirect(`${back}&err=${encodeURIComponent("Story not found.")}`);
  const typed = String(formData.get("newCriteria") ?? "").split(/\r?\n/).map((l) => l.trim().replace(/^AC\s*\d+\s*[:.)-]\s*/i, "").trim()).filter(Boolean);
  if (!typed.length) redirect(`${back}&err=${encodeURIComponent("Type at least one acceptance criterion.")}`);
  const have = parseCriteria(story.acceptanceCriteria);
  let next = have.reduce((m, c) => Math.max(m, Number(c.id.slice(2)) || 0), 0) + 1;
  const added = typed.map((t) => `AC${next++}: ${t}`);
  await prisma.story.update({ where: { id: storyId }, data: { acceptanceCriteria: [...have.map((c) => `${c.id}: ${c.text}`), ...added].join("\n") } });
  await syncStages(releaseId);
  redirect(`${back}&ok=${encodeURIComponent(added.length === 1 ? `${added[0].split(":")[0]} added` : `${added.length} acceptance criteria added`)}`);
}

/** Reads a story's acceptance criteria from its file when it has none yet. */
export async function fetchCriteria(formData: FormData) {
  const releaseId = s(formData, "releaseId"); const storyId = s(formData, "storyId");
  const back = `/releases/${releaseId}/execution?story=${storyId}`;
  const err = await fetchStoryCriteria(releaseId, storyId);
  redirect(`${back}&${err ? `err=${encodeURIComponent(err)}` : "ok=Acceptance criteria fetched"}`);
}

/** Keeps the address without running anything, so results can be recorded by hand. */
export async function saveTestUrl(formData: FormData) {
  const releaseId = s(formData, "releaseId"); const story = s(formData, "storyId");
  const back = `/releases/${releaseId}/execution${story ? `?story=${story}` : ""}`;
  const target = await setTestUrl(releaseId, s(formData, "url"), loginOf(formData));
  await syncStages(releaseId);
  redirect(`${back}${back.includes("?") ? "&" : "?"}${"error" in target ? `err=${encodeURIComponent(target.error)}` : "ok=URL saved"}`);
}

export async function runTickedInChrome(formData: FormData) {
  await runInChrome(formData, "execId");
}

export async function runShownInChrome(formData: FormData) {
  await runInChrome(formData, "shownId");
}

export async function recordResult(formData: FormData) {
  const id = s(formData, "id"); const releaseId = s(formData, "releaseId"); const buildId = s(formData, "buildId");
  await prisma.execution.update({
    where: { id },
    data: { result: s(formData, "result"), lane: s(formData, "lane"), executedBy: s(formData, "executedBy"), humanVerified: formData.get("humanVerified") === "on", actual: s(formData, "actual"), evidenceUrl: s(formData, "evidenceUrl"), notes: s(formData, "notes"), executedAt: new Date() },
  });
  revalidatePath(`/releases/${releaseId}/execution`);
  redirect(`/releases/${releaseId}/execution?build=${buildId}#exec-${id}`);
}

export async function bulkResult(formData: FormData) {
  const releaseId = s(formData, "releaseId"); const buildId = s(formData, "buildId");
  const ids = formData.getAll("execId").map(String);
  const result = s(formData, "result"); const executedBy = s(formData, "executedBy"); const lane = s(formData, "lane");
  if (!ids.length) redirect(`/releases/${releaseId}/execution?build=${buildId}&err=Select at least one case`);
  await prisma.execution.updateMany({ where: { id: { in: ids } }, data: { result, executedBy, lane, executedAt: new Date(), humanVerified: executedBy === "Human" && result !== "Not run" } });
  await syncStages(releaseId);
  redirect(`/releases/${releaseId}/execution?build=${buildId}&ok=${encodeURIComponent(`${ids.length} cases marked ${result}`)}`);
}

export async function addRun(formData: FormData) {
  const releaseId = s(formData, "releaseId");
  const passed = Number(formData.get("passed") ?? 0), failed = Number(formData.get("failed") ?? 0), flaky = Number(formData.get("flaky") ?? 0), skipped = Number(formData.get("skipped") ?? 0);
  await prisma.automationRun.create({ data: { releaseId, source: s(formData, "source") || "playwright", runLabel: s(formData, "runLabel"), passed, failed, flaky, skipped, total: passed + failed + flaky + skipped, durationSec: Number(formData.get("durationSec") ?? 0) } });
  redirect(`/releases/${releaseId}/automation?ok=Run recorded`);
}

export async function deleteRun(formData: FormData) {
  const id = s(formData, "id"); const releaseId = s(formData, "releaseId");
  await prisma.automationRun.delete({ where: { id } });
  revalidatePath(`/releases/${releaseId}/automation`);
}
