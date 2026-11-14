import { cache } from "react";
import { coverageGaps } from "./coverage";
import { runningJob } from "./jobs";
import { prisma } from "./prisma";
import { computeMetrics, evaluateGates } from "./workflow";

export type Tone = "ok" | "warn" | "bad" | "accent" | undefined;
export type FlowState = { status: string; tone: Tone; detail: string };

/** Flow 1 only stores files. Test cases can start once one of them can be read. */
export async function filesState(releaseId: string): Promise<FlowState & { complete: boolean }> {
  const [docs, protos] = await Promise.all([
    prisma.document.findMany({ where: { releaseId }, select: { fileName: true, status: true } }),
    prisma.prototype.count({ where: { releaseId } }),
  ]);
  if (!docs.length && !protos) return { status: "Not started", tone: undefined, detail: "Add the PRD, user stories, prototype and module fields.", complete: false };
  const unread = docs.filter((d) => d.status !== "Ready").map((d) => d.fileName);
  const stored = docs.length - unread.length + protos;
  const problem = unread.length ? `Could not read: ${unread.join(", ")}. Replace or remove them.` : "";
  if (!stored) return { status: "Unread", tone: "bad", detail: problem, complete: false };
  return { status: `${stored} stored`, tone: unread.length ? "warn" : "ok", detail: `${stored} file${stored === 1 ? "" : "s"} stored. ${problem}`.trim(), complete: true };
}

/** The last run that got as far as listing the stories, whether it finished or stopped part way. */
function lastStoryRead(releaseId: string) {
  return prisma.generationJob.findFirst({ where: { releaseId, kind: "prd", status: { not: "Running" }, storiesTotal: { gt: 0 } }, orderBy: { startedAt: "desc" } });
}

/** True when a user stories file was added or replaced after the stories were last listed. A PRD lists no stories, so it never counts. */
export async function filesChangedSinceRead(releaseId: string) {
  const last = await lastStoryRead(releaseId);
  if (!last) return false;
  return (await prisma.document.count({ where: { releaseId, docType: "User stories", uploadedAt: { gte: last.startedAt } } })) > 0;
}

/** Shared within one page render: the release nav, the page and syncStages each ask for it. */
export const flowStates = cache((releaseId: string) => flowStatesNow(releaseId));

async function flowStatesNow(releaseId: string) {
  const [files, running, stories, scripts, builds, bugs, triggers, drafts, protos, storyFiles] = await Promise.all([
    filesState(releaseId),
    runningJob(releaseId),
    prisma.story.findMany({ where: { releaseId }, include: { testCases: true, coverage: true } }),
    prisma.automationScript.findMany({ where: { releaseId }, select: { storyRefId: true, status: true } }),
    prisma.build.findMany({ where: { releaseId }, orderBy: { deployedAt: "desc" }, take: 1, include: { executions: { select: { result: true } }, criteria: { select: { result: true } } } }),
    prisma.bug.findMany({ where: { releaseId }, select: { status: true, webhookStatus: true } }),
    prisma.uiTrigger.findMany({ where: { releaseId }, select: { result: true } }),
    prisma.bugCandidate.count({ where: { releaseId, status: "Pending" } }),
    prisma.prototype.findMany({ where: { releaseId }, select: { matchResult: true } }),
    prisma.document.count({ where: { releaseId, status: "Ready", docType: "User stories" } }),
  ]);

  const cases = stories.flatMap((s) => s.testCases);
  const dataRows = await prisma.testDataRow.count({ where: { story: { releaseId } } });
  const gaps = stories.reduce((a, s) => a + coverageGaps(s.acceptanceCriteria, s.coverage, s.testCases).length, 0);
  const testcases: FlowState =
    running?.kind === "testcases" ? { status: "Running", tone: "accent", detail: "Generating test cases." }
    : running?.kind === "prd" ? { status: "Running", tone: "accent", detail: "Listing the user stories." }
    : !stories.length ? (storyFiles ? { status: "Ready", tone: "accent", detail: "Load the user stories from your file." } : { status: "Waiting", tone: undefined, detail: "Waiting for a user stories file in step 1." })
    : !cases.length ? { status: "Ready", tone: "accent", detail: "Select stories and generate their test cases." }
    : gaps ? { status: "Gaps", tone: "warn", detail: `${gaps} requirements uncovered across ${stories.length} stories.` }
    : { status: "Generated", tone: "ok", detail: `${cases.length} cases and ${dataRows} test data rows.` };

  const toReview = cases.filter((c) => !c.reviewed).length;
  const review: FlowState =
    !cases.length ? { status: "Waiting", tone: undefined, detail: "Waiting for generated test cases." }
    : toReview ? { status: `${toReview} to review`, tone: "warn", detail: `${toReview} of ${cases.length} cases are not reviewed.` }
    : { status: "Complete", tone: "ok", detail: `All ${cases.length} cases reviewed.` };

  const scripted = new Set(scripts.map((s) => s.storyRefId));
  const withCases = stories.filter((s) => s.testCases.length);
  const playwright: FlowState =
    running?.kind === "playwright" ? { status: "Running", tone: "accent", detail: "Writing Playwright scripts." }
    : running?.kind === "pw-run" ? { status: "Running", tone: "accent", detail: "Running the Playwright scripts." }
    : !scripts.length ? { status: "Not started", tone: undefined, detail: "No scripts yet." }
    : scripts.some((s) => s.status === "Syntax error") ? { status: "Errors", tone: "bad", detail: "A stored script has a syntax error." }
    : scripts.some((s) => s.status === "Blocked by policy") ? { status: "Errors", tone: "bad", detail: "A stored script reaches past the browser and will not run. See its error." }
    : withCases.some((s) => !scripted.has(s.id)) ? { status: "Partial", tone: "warn", detail: `${scripted.size} of ${withCases.length} stories have scripts.` }
    : { status: "Stored", tone: "ok", detail: `${scripts.length} script files stored.` };

  const execs = builds[0]?.executions ?? [];
  const notRun = execs.filter((e) => e.result === "Not run").length;
  const acs = builds[0]?.criteria ?? [];
  const acFailed = acs.filter((r) => r.result === "Fail").length;
  const acBlocked = acs.filter((r) => r.result === "Blocked").length;
  const execution: FlowState =
    running?.kind === "chrome" || running?.kind === "criteria" ? { status: "Running", tone: "accent", detail: "Checking in Chrome." }
    : !builds.length ? { status: "Not started", tone: undefined, detail: "Enter the URL to test." }
    : acs.length ? (acFailed ? { status: `${acFailed} failed`, tone: "bad", detail: `${acFailed} of ${acs.length} checked criteria failed.` } : { status: `${acs.length - acBlocked} passed`, tone: acBlocked ? "warn" : "ok", detail: `${acs.length - acBlocked} of ${acs.length} checked criteria passed${acBlocked ? `, ${acBlocked} blocked` : ""}.` })
    : !execs.length ? { status: "Not planned", tone: "warn", detail: "No test cases to run yet." }
    : notRun ? { status: "In progress", tone: "accent", detail: `${notRun} of ${execs.length} not run.` }
    : { status: "Executed", tone: "ok", detail: `${execs.length} cases have a result.` };

  const failedTriggers = triggers.filter((t) => t.result === "Fail").length;
  const differ = protos.filter((p) => p.matchResult === "Mismatch").length;
  const matched = protos.filter((p) => p.matchResult === "Match").length;
  const flowResults = await prisma.uiFlow.findMany({ where: { releaseId }, select: { result: true } });
  const flowsDiffer = flowResults.filter((f) => f.result === "Mismatch").length;
  const flowNote = flowResults.length ? ` ${flowsDiffer} of ${flowResults.length} flows differ.` : "";
  const storyResults = await prisma.storyFlow.findMany({ where: { releaseId }, select: { result: true } });
  const storiesDiffer = storyResults.filter((f) => f.result === "Mismatch").length;
  const storyNote = storyResults.length ? ` ${storiesDiffer} of ${storyResults.length} user-story flows differ from their stories.` : "";
  const ui: FlowState =
    running?.kind === "ui-match" ? { status: "Running", tone: "accent", detail: "Comparing the prototype with the build." }
    : running?.kind === "ui-extract" ? { status: "Running", tone: "accent", detail: "Finding triggers in the prototype." }
    : running?.kind === "ui-run" ? { status: "Running", tone: "accent", detail: "Testing triggers in the browser." }
    : running?.kind === "story-checks" ? { status: "Running", tone: "accent", detail: "Writing the user-story checks." }
    : running?.kind === "story-run" ? { status: "Running", tone: "accent", detail: "Checking the user stories on the build." }
    : !protos.length && !storyResults.length ? { status: "Not started", tone: undefined, detail: "Upload the prototype, or write the user-story checks." }
    : differ || flowsDiffer || storiesDiffer ? { status: `${differ + flowsDiffer + storiesDiffer} differ`, tone: "bad", detail: `${protos.length ? `${differ} of ${protos.length} screens do not match the prototype.${flowNote}` : ""}${storyNote}`.trim() }
    : failedTriggers ? { status: `${failedTriggers} failed`, tone: "bad", detail: `${failedTriggers} of ${triggers.length} triggers failed.` }
    : protos.every((p) => p.matchResult === "Not run") ? { status: "Ready", tone: "accent", detail: "Compare the prototype with a build." }
    : matched < protos.length ? { status: "Partial", tone: "warn", detail: `${matched} of ${protos.length} screens match the prototype.` }
    : { status: "Matches", tone: "ok", detail: `All ${protos.length} screens match the prototype.` };

  const [apiEndpoints, apiTests] = await Promise.all([prisma.apiEndpoint.count({ where: { releaseId } }), prisma.apiTest.findMany({ where: { releaseId }, select: { result: true } })]);
  const apiFailed = apiTests.filter((t) => t.result === "Fail").length;
  const apiBlocked = apiTests.filter((t) => t.result === "Blocked").length;
  const apiNotRun = apiTests.filter((t) => t.result === "Not run").length;
  const api: FlowState =
    running?.kind === "api-tests" ? { status: "Running", tone: "accent", detail: "Writing the API tests." }
    : running?.kind === "api-run" ? { status: "Running", tone: "accent", detail: "Sending the API tests." }
    : !apiEndpoints ? { status: "Not started", tone: undefined, detail: "Add the API list." }
    : !apiTests.length ? { status: "Ready", tone: "accent", detail: `Write the tests for ${apiEndpoints} endpoint${apiEndpoints === 1 ? "" : "s"}.` }
    : apiFailed ? { status: `${apiFailed} failed`, tone: "bad", detail: `${apiFailed} of ${apiTests.length} API tests failed.` }
    : apiNotRun === apiTests.length ? { status: "Ready", tone: "accent", detail: `${apiTests.length} API tests written, none sent yet.` }
    : apiBlocked === apiTests.length ? { status: "Blocked", tone: "warn", detail: "The API could not be reached, or the tests need variables that are not set." }
    : apiNotRun || apiBlocked ? { status: "Partial", tone: "warn", detail: `${apiTests.length - apiNotRun - apiBlocked} of ${apiTests.length} API tests passed; ${apiNotRun} not sent, ${apiBlocked} blocked.` }
    : { status: "Passed", tone: "ok", detail: `All ${apiTests.length} API tests passed.` };

  const scan = await prisma.securityScan.findFirst({ where: { releaseId }, orderBy: { startedAt: "desc" }, include: { findings: { select: { result: true, risk: true } } } });
  const sec = (risk: string) => scan?.findings.filter((x) => x.result === "Fail" && x.risk === risk).length ?? 0;
  const secWarn = scan?.findings.filter((x) => x.result === "Warn" || (x.result === "Fail" && (x.risk === "Low" || x.risk === "Info"))).length ?? 0;
  const security: FlowState =
    running?.kind === "security" ? { status: "Running", tone: "accent", detail: "Scanning the URL to test." }
    : !scan ? { status: "Not started", tone: undefined, detail: "Run the security scan." }
    : scan.status === "Running" ? { status: "Running", tone: "accent", detail: "Scanning the URL to test." }
    : scan.status === "Failed" ? { status: "Failed", tone: "bad", detail: "The last scan did not finish. See its log." }
    : sec("High") + sec("Medium") ? { status: `${sec("High") + sec("Medium")} to fix`, tone: "bad", detail: `${sec("High")} high and ${sec("Medium")} medium risk findings.` }
    : secWarn ? { status: "Low only", tone: "warn", detail: `${secWarn} low or informational findings, nothing high or medium.` }
    : { status: "Clean", tone: "ok", detail: `Nothing found by ${scan.findings.length} checks.` };

  const openBugs = bugs.filter((b) => !["Closed", "Rejected"].includes(b.status)).length;
  const failedPush = bugs.filter((b) => b.webhookStatus === "failed").length;
  const bugFlow: FlowState =
    failedPush ? { status: "Push failed", tone: "bad", detail: `${failedPush} bugs did not reach the connector.` }
    : drafts ? { status: `${drafts} to confirm`, tone: "warn", detail: `${drafts} failures are waiting to be confirmed as bugs.` }
    : openBugs ? { status: `${openBugs} open`, tone: "warn", detail: `${openBugs} bugs open.` }
    : bugs.length ? { status: "All closed", tone: "ok", detail: `${bugs.length} bugs, none open.` }
    : { status: "None", tone: undefined, detail: "No bugs logged." };

  return { files, testcases, review, playwright, execution, ui, api, security, bugs: { ...bugFlow, open: openBugs, drafts, total: bugs.length, failedPush } };
}

/** Keep the 13-stage board in step with what the pages actually did. Stage 13 is set by hand; a stage with nothing to go on yet keeps what a person set. */
export async function syncStages(releaseId: string) {
  const [f, m, build, signoff] = await Promise.all([
    flowStates(releaseId),
    computeMetrics(releaseId),
    prisma.build.findFirst({ where: { releaseId }, orderBy: { deployedAt: "desc" }, select: { envUrl: true, number: true } }),
    prisma.signoff.findUnique({ where: { releaseId }, select: { recommendation: true, buildNo: true } }),
  ]);
  const gates = await evaluateGates(releaseId, m);
  // Opening a page should not write: only a stage whose status or note actually changed is saved.
  const rows = new Map((await prisma.stageStatus.findMany({ where: { releaseId }, select: { stageNo: true, status: true, note: true } })).map((r) => [r.stageNo, r]));
  const set = async (stageNo: number, status: string, note: string) => {
    const was = rows.get(stageNo);
    if (was && was.status === status && was.note === note) return;
    await prisma.stageStatus.upsert({ where: { releaseId_stageNo: { releaseId, stageNo } }, update: { status, note }, create: { releaseId, stageNo, status, note } });
  };
  await set(1, f.files.complete ? "Done" : f.files.status === "Not started" ? "Pending" : "In progress", f.files.detail);
  await set(2, f.testcases.status === "Waiting" || f.testcases.status === "Ready" ? "Pending" : f.testcases.status === "Gaps" || f.testcases.status === "Running" ? "In progress" : "Done", f.testcases.detail);
  await set(3, f.review.status === "Waiting" ? "Pending" : f.review.status === "Complete" ? "Done" : "In progress", f.review.detail);
  // AC check: the URL is set (Gate 3), then the criteria checked in Chrome say how it goes.
  await set(4,
    !gates[2].met ? "Pending" : f.execution.status.endsWith("failed") ? "Failed" : f.execution.status.endsWith("passed") && !f.execution.detail.includes("blocked") ? "Done" : "In progress",
    !gates[2].met ? "Enter the URL to test in AC Check." : `Testing ${build?.envUrl}. ${f.execution.detail}`);
  // Smoke is optional: with nothing flagged, Gate 4 is met and the stage is done without a run.
  await set(5,
    !m.smokeTotal ? "Done" : m.smokeFail ? "Failed" : m.smokePass === m.smokeTotal ? "Done" : "In progress",
    !m.smokeTotal ? "No case is flagged smoke, so Gate 4 is met without a run. Flag cases in Test case review to make it a gate."
    : m.smokeFail ? `${m.smokeFail} of ${m.smokeTotal} smoke cases failed on build ${build?.number ?? ""}.`
    : m.smokePass === m.smokeTotal ? `All ${m.smokeTotal} smoke cases passed on build ${build?.number ?? ""}.`
    : `${m.smokePass} of ${m.smokeTotal} smoke cases passed, ${m.smokeTotal - m.smokePass} not run yet.`);
  await set(6, f.playwright.status === "Not started" ? "Pending" : f.playwright.status === "Stored" ? "Done" : f.playwright.status === "Errors" ? "Failed" : "In progress", f.playwright.detail);
  await set(7,
    f.api.status === "Not started" || f.api.status === "Ready" ? "Pending" : f.api.status === "Running" || f.api.status === "Partial" || f.api.status === "Blocked" ? "In progress" : f.api.status === "Passed" ? "Done" : "Failed",
    f.api.detail);
  await set(8,
    f.ui.status === "Not started" || f.ui.status === "Ready" ? "Pending" : f.ui.status === "Running" || f.ui.status === "Partial" ? "In progress" : f.ui.status === "Matches" ? "Done" : "Failed",
    f.ui.detail);
  await set(9,
    f.security.status === "Not started" ? "Pending" : f.security.status === "Running" ? "In progress" : f.security.status === "Clean" || f.security.status === "Low only" ? "Done" : "Failed",
    f.security.detail);
  if (f.bugs.failedPush) await set(10, "Failed", f.bugs.detail);
  else if (f.bugs.drafts) await set(10, "In progress", f.bugs.detail);
  else if (f.bugs.total) await set(10, "Done", `${f.bugs.total} bugs logged, ${f.bugs.open} open.`);
  if (f.bugs.total) await set(11, f.bugs.open ? "In progress" : "Done", f.bugs.open ? `${f.bugs.open} bugs open. Retest each Fixed one before closing it.` : `All ${f.bugs.total} bugs closed or rejected.`);
  if (signoff) await set(12, signoff.recommendation === "No-go" ? "In progress" : "Done", `${signoff.recommendation}${signoff.buildNo ? ` on build ${signoff.buildNo}` : ""}.`);
}
