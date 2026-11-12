"use server";

import { syncStages } from "@/lib/flows";
import { prisma } from "@/lib/prisma";
import { setTestUrl } from "@/lib/testurl";
import { saveMatch, startTriggerSearch, startUiMatch, startUiRun } from "@/lib/uitesting";
import { cleanSteps, startStoryChecks, startStoryRun } from "@/lib/storychecks";
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
  const withFlows = formData.get("flows") === "on";
  // A screen whose own page matches is still open while one of its flows does not.
  const openFlows = withFlows ? new Set((await prisma.uiFlow.findMany({ where: { releaseId, result: { not: "Match" } }, select: { prototypeId: true } })).map((f) => f.prototypeId)) : new Set<string>();
  const ids = one ? [one] : s(formData, "scope") === "open" ? protos.filter((p) => p.matchResult !== "Match" || openFlows.has(p.id)).map((p) => p.id) : undefined;
  if (ids && !ids.length) redirect(`${back}?err=${encodeURIComponent("Every screen matches already.")}`);
  const err = await startUiMatch(releaseId, build.id, ids, Number(s(formData, "width")) || undefined, withFlows);
  // One screen opens on its own, with its progress, rather than among every screen's results.
  const focus = one ? `screen=${encodeURIComponent(one)}&` : "";
  redirect(err ? `${back}?${focus}err=${encodeURIComponent(err)}` : `${back}?${focus}info=${encodeURIComponent("Comparison started")}`);
}

/** One flow checked again on the build: its screen is taken first, as the flow leaves out what the screen showed. */
export async function checkFlow(formData: FormData) {
  const releaseId = s(formData, "releaseId"), id = s(formData, "flow");
  const back = `/releases/${releaseId}/ui-testing`;
  const f = await prisma.uiFlow.findUnique({ where: { id }, select: { releaseId: true, prototypeId: true, name: true } });
  if (!f || f.releaseId !== releaseId) redirect(`${back}?err=${encodeURIComponent("Flow not found.")}`);
  const build = await latestBuild(releaseId);
  if (!build?.envUrl) redirect(`${back}?err=${encodeURIComponent(NO_URL)}`);
  const err = await startUiMatch(releaseId, build.id, [f.prototypeId], Number(s(formData, "width")) || undefined, true, [id]);
  redirect(`${back}?screen=${encodeURIComponent(f.prototypeId)}&flow=${encodeURIComponent(id)}&${err ? `err=${encodeURIComponent(err)}` : `info=${encodeURIComponent(`Checking ${f.name} again`)}`}`);
}

/** Forget a screen's flows, so the next comparison clicks through its prototype again to find them. */
export async function findFlowsAgain(formData: FormData) {
  const releaseId = s(formData, "releaseId"), id = s(formData, "screen");
  const p = await prisma.prototype.findUnique({ where: { id }, select: { releaseId: true, screen: true, flows: { select: { id: true } } } });
  if (!p || p.releaseId !== releaseId) redirect(`/releases/${releaseId}/ui-testing?err=${encodeURIComponent("Screen not found.")}`);
  await prisma.bugCandidate.deleteMany({ where: { releaseId, refKey: { in: p.flows.map((f) => `flow:${f.id}`) }, status: "Pending" } });
  await prisma.uiFlow.deleteMany({ where: { prototypeId: id } });
  await prisma.prototype.update({ where: { id }, data: { flowsFoundAt: null } });
  await syncStages(releaseId);
  redirect(`/releases/${releaseId}/ui-testing?ok=${encodeURIComponent(`${p.screen}: its flows are found again on the next comparison`)}`);
}

/** Stop comparing one flow, such as a state that is not part of this release. */
export async function removeFlow(formData: FormData) {
  const releaseId = s(formData, "releaseId"), id = s(formData, "flow");
  const f = await prisma.uiFlow.findUnique({ where: { id }, select: { releaseId: true, name: true } });
  if (!f || f.releaseId !== releaseId) redirect(`/releases/${releaseId}/ui-testing?err=${encodeURIComponent("Flow not found.")}`);
  await prisma.bugCandidate.deleteMany({ where: { releaseId, refKey: `flow:${id}`, status: "Pending" } });
  await prisma.uiFlow.delete({ where: { id } });
  await syncStages(releaseId);
  redirect(`/releases/${releaseId}/ui-testing?ok=${encodeURIComponent(`Flow ${f.name} removed`)}`);
}

/** Where the user-story section sends back to: the story being worked on stays open. */
const storyBack = (releaseId: string, story: string, message: string) => `/releases/${releaseId}/ui-testing?${story ? `story=${encodeURIComponent(story)}&` : ""}${message}#${story ? `story-${story}` : "stories"}`;

/** Claude writes the user-story checks from each story's acceptance criteria and field rules, after mapping the build. */
export async function writeStoryChecks(formData: FormData) {
  const releaseId = s(formData, "releaseId"), story = s(formData, "story");
  const scope = story ? { storyRefId: story } : s(formData, "scope") === "all" ? "all" : "missing";
  const err = await startStoryChecks(releaseId, scope, formData.get("remap") === "on");
  redirect(storyBack(releaseId, story, err ? `err=${encodeURIComponent(err)}` : `info=${encodeURIComponent("Writing the user-story checks")}`));
}

/** Playwright checks the user-story flows on the build: all, those not matching, one story's or one flow. */
export async function runStoryChecks(formData: FormData) {
  const releaseId = s(formData, "releaseId"), story = s(formData, "story"), flow = s(formData, "flow");
  const scope = flow ? { flowId: flow } : story ? { storyRefId: story } : s(formData, "scope") === "open" ? "open" : "all";
  const err = await startStoryRun(releaseId, scope, formData.get("validation") === "on");
  redirect(storyBack(releaseId, story, err ? `err=${encodeURIComponent(err)}` : `info=${encodeURIComponent("Checking the user stories on the build")}`));
}

/** A flow's page and steps, corrected by hand when the build names them differently. */
export async function saveStoryFlow(formData: FormData) {
  const releaseId = s(formData, "releaseId"), id = s(formData, "flow");
  const f = await prisma.storyFlow.findUnique({ where: { id }, select: { releaseId: true, storyRefId: true } });
  if (!f || f.releaseId !== releaseId) redirect(storyBack(releaseId, "", `err=${encodeURIComponent("Flow not found.")}`));
  const page = s(formData, "page");
  if (page && !page.startsWith("/")) redirect(storyBack(releaseId, f.storyRefId, `err=${encodeURIComponent("Type the page as a path, starting with /, for example /boq.")}`));
  await prisma.storyFlow.update({ where: { id }, data: { page, steps: JSON.stringify(cleanSteps(s(formData, "steps"))) } });
  redirect(storyBack(releaseId, f.storyRefId, `ok=${encodeURIComponent("Flow saved. Check it again to see the result.")}`));
}

export async function removeStoryFlow(formData: FormData) {
  const releaseId = s(formData, "releaseId"), id = s(formData, "flow");
  const f = await prisma.storyFlow.findUnique({ where: { id }, select: { releaseId: true, storyRefId: true, name: true } });
  if (!f || f.releaseId !== releaseId) redirect(storyBack(releaseId, "", `err=${encodeURIComponent("Flow not found.")}`));
  await prisma.bugCandidate.deleteMany({ where: { releaseId, refKey: `story:${id}`, status: "Pending" } });
  await prisma.storyFlow.delete({ where: { id } });
  await syncStages(releaseId);
  redirect(storyBack(releaseId, f.storyRefId, `ok=${encodeURIComponent(`Flow ${f.name} removed`)}`));
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
