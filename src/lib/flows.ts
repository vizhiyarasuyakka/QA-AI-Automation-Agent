import { coverageGaps } from "./coverage";
import { runningJob } from "./jobs";
import { prisma } from "./prisma";

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

export async function flowStates(releaseId: string) {
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
  const ui: FlowState =
    running?.kind === "ui-match" ? { status: "Running", tone: "accent", detail: "Comparing the prototype with the build." }
    : running?.kind === "ui-extract" ? { status: "Running", tone: "accent", detail: "Finding triggers in the prototype." }
    : running?.kind === "ui-run" ? { status: "Running", tone: "accent", detail: "Testing triggers in the browser." }
    : !protos.length ? { status: "Not started", tone: undefined, detail: "Upload the prototype." }
    : differ ? { status: `${differ} differ`, tone: "bad", detail: `${differ} of ${protos.length} screens do not match the prototype.` }
    : failedTriggers ? { status: `${failedTriggers} failed`, tone: "bad", detail: `${failedTriggers} of ${triggers.length} triggers failed.` }
    : protos.every((p) => p.matchResult === "Not run") ? { status: "Ready", tone: "accent", detail: "Compare the prototype with a build." }
    : matched < protos.length ? { status: "Partial", tone: "warn", detail: `${matched} of ${protos.length} screens match the prototype.` }
    : { status: "Matches", tone: "ok", detail: `All ${protos.length} screens match the prototype.` };

  const openBugs = bugs.filter((b) => !["Closed", "Rejected"].includes(b.status)).length;
  const failedPush = bugs.filter((b) => b.webhookStatus === "failed").length;
  const bugFlow: FlowState =
    failedPush ? { status: "Push failed", tone: "bad", detail: `${failedPush} bugs did not reach the connector.` }
    : drafts ? { status: `${drafts} to confirm`, tone: "warn", detail: `${drafts} failures are waiting to be confirmed as bugs.` }
    : openBugs ? { status: `${openBugs} open`, tone: "warn", detail: `${openBugs} bugs open.` }
    : bugs.length ? { status: "All closed", tone: "ok", detail: `${bugs.length} bugs, none open.` }
    : { status: "None", tone: undefined, detail: "No bugs logged." };

  return { files, testcases, review, playwright, execution, ui, bugs: bugFlow };
}

/** Keep the 13-stage board in step with what the flows actually did. */
export async function syncStages(releaseId: string) {
  const f = await flowStates(releaseId);
  const set = (stageNo: number, status: string, note: string) => prisma.stageStatus.upsert({ where: { releaseId_stageNo: { releaseId, stageNo } }, update: { status, note }, create: { releaseId, stageNo, status, note } });
  await set(1, f.files.complete ? "Done" : f.files.status === "Not started" ? "Pending" : "In progress", f.files.detail);
  await set(2, f.testcases.status === "Waiting" || f.testcases.status === "Ready" ? "Pending" : f.testcases.status === "Gaps" || f.testcases.status === "Running" ? "In progress" : "Done", f.testcases.detail);
  await set(3, f.review.status === "Waiting" ? "Pending" : f.review.status === "Complete" ? "Done" : "In progress", f.review.detail);
  if (f.playwright.status !== "Not started") await set(11, f.playwright.status === "Stored" ? "Done" : "In progress", f.playwright.detail);
}
