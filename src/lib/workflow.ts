import { coverageGaps } from "./coverage";
import { prisma } from "./prisma";

export const THRESHOLDS = {
  P1_PASS_RATE: 0.95,
  AUTOMATION_STABILITY: 0.95,
  AUTOMATION_COVERAGE: 0.8,
  REOPEN_RATE_MAX: 0.1,
  MTTF_HIGH_HOURS: 24,
  STABILITY_WINDOW: 10,
};

export type StageDef = {
  no: number;
  name: string;
  gate?: string;
  tools: string;
  href: (releaseId: string) => string;
};

export const STAGES: StageDef[] = [
  { no: 1, name: "Intake", gate: "Gate 1: every story has acceptance criteria", tools: "Store PRD, user stories, prototype and module fields", href: (r) => `/releases/${r}/documents` },
  { no: 2, name: "Test design", tools: "Select user stories, generate test cases and test data, or paste", href: (r) => `/releases/${r}/stories` },
  { no: 3, name: "Test review", gate: "Gate 2: every case reviewed, every requirement covered", tools: "Export cases or mark them reviewed", href: (r) => `/releases/${r}/review` },
  { no: 4, name: "Environment and test data", gate: "Gate 3: the URL to test is set", tools: "URL to test, entered in step 4", href: (r) => `/releases/${r}/execution` },
  { no: 5, name: "Build acceptance (smoke)", gate: "Gate 4: smoke 100% pass", tools: "Playwright @smoke, Chrome extension", href: (r) => `/releases/${r}/execution` },
  { no: 6, name: "Scripted execution", tools: "UI, API (Postman), Risk (CodeAnt) lanes", href: (r) => `/releases/${r}/execution` },
  { no: 7, name: "Exploratory session", tools: "QA Bug Hunter, Playwright MCP, human charter", href: (r) => `/releases/${r}/execution` },
  { no: 8, name: "Non-functional lane", tools: "axe-core, OWASP ZAP, k6, visual snapshots", href: (r) => `/releases/${r}/execution` },
  { no: 9, name: "Defect logging", tools: "This app, webhook to in-house app", href: (r) => `/releases/${r}/bugs` },
  { no: 10, name: "Retest and regression", tools: "Playwright @p1 @module", href: (r) => `/releases/${r}/bugs` },
  { no: 11, name: "Automation harvest", tools: "Generated and stored Playwright scripts", href: (r) => `/releases/${r}/automation` },
  { no: 12, name: "Sign-off and report", gate: "Gate 5: 0 Critical, 0 High open, P1 pass rate, NFR green, stability", tools: "This app", href: (r) => `/releases/${r}/signoff` },
  { no: 13, name: "Post-release monitoring", tools: "Prod logs, support tickets", href: (r) => `/releases/${r}/signoff` },
];

export type Metrics = {
  stories: number;
  storiesCovered: number;
  requirementCoverage: number;
  casesTotal: number;
  casesReviewed: number;
  casesApproved: number;
  reviewRate: number;
  latestBuild: string | null;
  planned: number;
  executed: number;
  progress: number;
  passRate: { P1: number; P2: number; P3: number; all: number };
  counts: { pass: number; fail: number; blocked: number; notRun: number };
  smokeTotal: number;
  smokePass: number;
  p1AiExecuted: number;
  p1HumanVerified: number;
  humanVerifiedRate: number;
  bugsTotal: number;
  openBySeverity: { Critical: number; High: number; Medium: number; Low: number };
  openCriticalHigh: number;
  openHighWithoutWorkaround: number;
  reopenRate: number;
  mttfHighHours: number;
  defectDensity: number;
  automationCoverage: number;
  p1RegressionTotal: number;
  p1RegressionAutomated: number;
  automationStability: number;
  runsConsidered: number;
  escapes: number;
  escapesCritical: number;
  nfrGreen: boolean;
};

export type GateResult = { no: number; name: string; met: boolean; reasons: string[] };

export async function computeMetrics(releaseId: string): Promise<Metrics> {
  const [stories, builds, bugs, runs, escapes, stageRows] = await Promise.all([
    prisma.story.findMany({ where: { releaseId }, include: { testCases: true, coverage: true } }),
    prisma.build.findMany({ where: { releaseId }, orderBy: { deployedAt: "desc" }, include: { executions: { include: { testCase: true } } } }),
    prisma.bug.findMany({ where: { releaseId } }),
    prisma.automationRun.findMany({ where: { releaseId, source: "playwright" }, orderBy: { ranAt: "desc" }, take: THRESHOLDS.STABILITY_WINDOW }),
    prisma.escape.findMany({ where: { releaseId } }),
    prisma.stageStatus.findMany({ where: { releaseId } }),
  ]);

  const cases = stories.flatMap((s) => s.testCases);
  const storiesCovered = stories.filter((s) => s.testCases.length > 0 && !coverageGaps(s.acceptanceCriteria, s.coverage, s.testCases).length).length;
  const casesReviewed = cases.filter((c) => c.reviewed).length;
  const casesApproved = cases.filter((c) => c.approved).length;

  const latest = builds[0];
  // Every case counts; nothing is approved first.
  const execs = latest ? latest.executions : [];
  const planned = cases.length;
  const byResult = (r: string) => execs.filter((e) => e.result === r).length;
  const counts = { pass: byResult("Pass"), fail: byResult("Fail"), blocked: byResult("Blocked"), notRun: Math.max(0, planned - execs.filter((e) => e.result !== "Not run").length) };
  const executed = counts.pass + counts.fail;
  const rateFor = (p?: string) => {
    const set = execs.filter((e) => (!p || e.testCase.priority === p) && (e.result === "Pass" || e.result === "Fail"));
    return set.length ? set.filter((e) => e.result === "Pass").length / set.length : 0;
  };
  const smokeCases = cases.filter((c) => c.smoke);
  const smokeExecs = execs.filter((e) => e.testCase.smoke);
  const p1Ai = execs.filter((e) => e.testCase.priority === "P1" && e.executedBy === "AI");
  const p1Human = p1Ai.filter((e) => e.humanVerified);

  // Fixed is the developer's word: a bug stays open until QA retests and closes it.
  const open = bugs.filter((b) => !["Closed", "Rejected"].includes(b.status));
  const sev = (s: string) => open.filter((b) => b.severity === s).length;
  const everFixed = bugs.filter((b) => b.fixedAt || b.status === "Fixed" || b.status === "Closed" || b.reopenCount > 0);
  const reopened = bugs.filter((b) => b.reopenCount > 0).length;
  const fixedHigh = bugs.filter((b) => b.fixedAt && (b.severity === "Critical" || b.severity === "High"));
  const mttf = fixedHigh.length ? fixedHigh.reduce((a, b) => a + (b.fixedAt!.getTime() - b.loggedAt.getTime()) / 36e5, 0) / fixedHigh.length : 0;

  const p1Reg = cases.filter((c) => c.priority === "P1" && c.regression);
  const p1RegAuto = p1Reg.filter((c) => c.automated);
  const runTotal = runs.reduce((a, r) => a + r.total, 0);
  const runPassed = runs.reduce((a, r) => a + r.passed, 0);

  const nfr = stageRows.find((s) => s.stageNo === 8);

  return {
    stories: stories.length,
    storiesCovered,
    requirementCoverage: stories.length ? storiesCovered / stories.length : 0,
    casesTotal: cases.length,
    casesReviewed,
    casesApproved,
    reviewRate: cases.length ? casesReviewed / cases.length : 0,
    latestBuild: latest ? latest.number : null,
    planned,
    executed,
    progress: planned ? executed / planned : 0,
    passRate: { P1: rateFor("P1"), P2: rateFor("P2"), P3: rateFor("P3"), all: rateFor() },
    counts,
    smokeTotal: smokeCases.length,
    smokePass: smokeExecs.filter((e) => e.result === "Pass").length,
    p1AiExecuted: p1Ai.length,
    p1HumanVerified: p1Human.length,
    humanVerifiedRate: p1Ai.length ? p1Human.length / p1Ai.length : 1,
    bugsTotal: bugs.length,
    openBySeverity: { Critical: sev("Critical"), High: sev("High"), Medium: sev("Medium"), Low: sev("Low") },
    openCriticalHigh: sev("Critical") + sev("High"),
    openHighWithoutWorkaround: open.filter((b) => b.severity === "High" && !b.workaround.trim()).length,
    reopenRate: everFixed.length ? reopened / everFixed.length : 0,
    mttfHighHours: mttf,
    defectDensity: stories.length ? bugs.length / stories.length : 0,
    automationCoverage: p1Reg.length ? p1RegAuto.length / p1Reg.length : 0,
    p1RegressionTotal: p1Reg.length,
    p1RegressionAutomated: p1RegAuto.length,
    automationStability: runTotal ? runPassed / runTotal : 0,
    runsConsidered: runs.length,
    escapes: escapes.length,
    escapesCritical: escapes.filter((e) => e.severity === "Critical").length,
    nfrGreen: !!nfr && nfr.status === "Done",
  };
}

export async function evaluateGates(releaseId: string, m?: Metrics): Promise<GateResult[]> {
  const metrics = m ?? (await computeMetrics(releaseId));
  const stories = await prisma.story.findMany({ where: { releaseId }, include: { testCases: true, coverage: true } });
  const latest = await prisma.build.findFirst({ where: { releaseId }, orderBy: { deployedAt: "desc" } });

  const g1: string[] = [];
  if (!stories.length) g1.push("no stories added");
  stories.forEach((s) => { if (!s.acceptanceCriteria.trim()) g1.push(`${s.storyId}: no acceptance criteria`); });

  const g2: string[] = [];
  if (!stories.length) g2.push("no stories added");
  stories.forEach((s) => {
    if (!s.testCases.length) g2.push(`${s.storyId}: no test cases`);
    const unreviewed = s.testCases.filter((t) => !t.reviewed).length;
    if (unreviewed) g2.push(`${s.storyId}: ${unreviewed} cases unreviewed`);
    const gaps = coverageGaps(s.acceptanceCriteria, s.coverage, s.testCases).length;
    if (gaps) g2.push(`${s.storyId}: ${gaps} requirements uncovered`);
  });

  const g3: string[] = [];
  if (!latest?.envUrl.trim()) g3.push("no URL to test; enter it in step 4");

  const g4: string[] = [];
  if (!metrics.smokeTotal) g4.push("no smoke cases flagged"); else if (metrics.smokePass < metrics.smokeTotal) g4.push(`smoke ${metrics.smokePass}/${metrics.smokeTotal} passed`);

  const g5: string[] = [];
  ([["Gate 1", g1], ["Gate 2", g2], ["Gate 3", g3], ["Gate 4", g4]] as const).forEach(([name, reasons]) => { if (reasons.length) g5.push(`${name} not met`); });
  if (metrics.openBySeverity.Critical) g5.push(`${metrics.openBySeverity.Critical} Critical open`);
  if (metrics.openHighWithoutWorkaround) g5.push(`${metrics.openHighWithoutWorkaround} High open without workaround`);
  if (metrics.passRate.P1 < THRESHOLDS.P1_PASS_RATE) g5.push(`P1 pass rate ${(metrics.passRate.P1 * 100).toFixed(0)}% below ${THRESHOLDS.P1_PASS_RATE * 100}%`);
  if (metrics.progress < 1) g5.push(`execution ${(metrics.progress * 100).toFixed(0)}% of planned`);
  if (metrics.humanVerifiedRate < 1) g5.push(`${metrics.p1AiExecuted - metrics.p1HumanVerified} AI-executed P1 cases not human-verified`);
  if (!metrics.nfrGreen) g5.push("non-functional lane not green");
  if (metrics.runsConsidered && metrics.automationStability < THRESHOLDS.AUTOMATION_STABILITY) g5.push(`automation stability ${(metrics.automationStability * 100).toFixed(0)}%`);

  return [
    { no: 1, name: "Intake", met: !g1.length, reasons: g1 },
    { no: 2, name: "Test review", met: !g2.length, reasons: g2 },
    { no: 3, name: "Environment", met: !g3.length, reasons: g3 },
    { no: 4, name: "Smoke", met: !g4.length, reasons: g4 },
    { no: 5, name: "Sign-off", met: !g5.length, reasons: g5 },
  ];
}

export function gateForStage(stageNo: number): number | null {
  return ({ 1: 1, 3: 2, 4: 3, 5: 4, 12: 5 } as Record<number, number>)[stageNo] ?? null;
}

export async function ensureStages(releaseId: string) {
  const existing = await prisma.stageStatus.findMany({ where: { releaseId } });
  const have = new Set(existing.map((s) => s.stageNo));
  const missing = STAGES.filter((s) => !have.has(s.no));
  if (missing.length) await prisma.stageStatus.createMany({ data: missing.map((s) => ({ releaseId, stageNo: s.no })) });
}

export function nextBugId(existing: string[]): string {
  const max = existing.reduce((m, id) => { const n = parseInt(id.replace(/\D/g, ""), 10); return isNaN(n) ? m : Math.max(m, n); }, 300);
  return `BUG-${max + 1}`;
}

export const pct = (v: number) => `${Math.round(v * 100)}%`;
