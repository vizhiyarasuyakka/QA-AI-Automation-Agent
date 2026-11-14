import { cache } from "react";
import { coverageGaps } from "./coverage";
import { securityVerdict, signoffReasons, THRESHOLDS, untriagedFailures } from "./gates";
import { prisma } from "./prisma";

export { THRESHOLDS };

export type StageDef = {
  no: number;
  name: string;
  gate?: string;
  tools: string;
  href: (releaseId: string) => string;
};

export const STAGES: StageDef[] = [
  { no: 1, name: "Requirement docs", gate: "Gate 1: every story has acceptance criteria", tools: "Store PRD, user stories, prototype and module fields", href: (r) => `/releases/${r}/documents` },
  { no: 2, name: "TC/TD: test cases and test data", tools: "Select user stories, generate test cases and test data, or paste", href: (r) => `/releases/${r}/stories` },
  { no: 3, name: "Test review", gate: "Gate 2: every case reviewed, every requirement covered", tools: "Export cases or mark them reviewed", href: (r) => `/releases/${r}/review` },
  { no: 4, name: "AC Check", gate: "Gate 3: the URL to test is set", tools: "The URL to test and the test account; every acceptance criterion checked in Chrome", href: (r) => `/releases/${r}/execution` },
  { no: 5, name: "Smoke", gate: "Gate 4: every case flagged smoke passes; met when none is flagged", tools: "Flag cases smoke in Test case review; results come from Playwright runs or CI imports", href: (r) => `/releases/${r}/review` },
  { no: 6, name: "Playwright Test", tools: "Specs written from the test cases, run with Playwright Test in a hidden Chrome or from CI", href: (r) => `/releases/${r}/automation` },
  { no: 7, name: "API Test", tools: "Positive, negative and edge-case tests written from the API list, sent with Playwright", href: (r) => `/releases/${r}/api-testing` },
  { no: 8, name: "UI Testing", tools: "Prototype compared screen by screen and flow by flow; user stories checked field by field", href: (r) => `/releases/${r}/ui-testing` },
  { no: 9, name: "Security Testing", tools: "Built-in checks in Playwright and the OWASP ZAP baseline scan, both free; what fails is listed", href: (r) => `/releases/${r}/security` },
  { no: 10, name: "Defect logging", tools: "This app, MCP connector or webhook to your tracker", href: (r) => `/releases/${r}/bugs` },
  { no: 11, name: "Retest and regression", tools: "Fixed and Reopened statuses; reopen rate", href: (r) => `/releases/${r}/bugs` },
  { no: 12, name: "Sign-off and report", gate: "Gate 5: 0 Critical, 0 High open, P1 pass rate, security green, stability", tools: "This app", href: (r) => `/releases/${r}/signoff` },
  { no: 13, name: "Post-release monitoring", tools: "Prod logs, support tickets", href: (r) => `/releases/${r}/signoff` },
];

/** What each stage runs on: the free tools, and where Claude, Codex or a plugin skill comes in. flow names the connection it is chosen with in Settings. */
export const STAGE_USES: Record<number, { tools: string; ai: string; flow?: "testcases" | "execution" | "playwright" | "api" | "ui" | "bugs" }> = {
  1: { tools: "pdf-parse, mammoth and exceljs read the uploaded files; prototypes are kept as files", ai: "Claude reads prototype pictures when a step needs them (your login)" },
  2: { tools: "coverage.ts computes what each story still lacks; exceljs writes the sheets", ai: "Claude or ChatGPT writes the test cases and test data; a plugin skill can shape them", flow: "testcases" },
  3: { tools: "exceljs exports; no model runs", ai: "None" },
  4: { tools: "Playwright opens a Chrome window of its own for local addresses", ai: "Claude in Chrome checks each criterion; on local addresses Claude drives Playwright", flow: "execution" },
  5: { tools: "Playwright Test runs the smoke-flagged cases; CI imports at /api/import/playwright and /api/import/newman", ai: "None" },
  6: { tools: "Playwright Test runs the specs in a hidden Chrome; download the zip to run them in CI", ai: "Claude or ChatGPT writes one spec per story; e2e plugin skills can be chosen", flow: "playwright" },
  7: { tools: "Playwright's request API sends the tests, no browser; Postman collection and Newman supported", ai: "Claude or ChatGPT writes the positive, negative and edge-case tests", flow: "api" },
  8: { tools: "Playwright, pixelmatch and sharp compare the prototype and the build and draw the evidence", ai: "Claude writes the user-story checks after the build is mapped, and finds the triggers", flow: "ui" },
  9: { tools: "Built-in checks in Playwright (headers, cookies, HTTPS, redirects, reflected input, exposed files) and the OWASP ZAP baseline scan in Docker", ai: "None" },
  10: { tools: "This app's bug form; MCP connector or webhook to your tracker", ai: "None; the connector is chosen here", flow: "bugs" },
  11: { tools: "Status rules in this app", ai: "None" },
  12: { tools: "The twelve metrics computed in workflow.ts", ai: "None" },
  13: { tools: "Escapes logged by hand", ai: "None" },
};

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
  smokeFail: number;
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
  securityNote: string;
  /** Failures from AC Check, API Test and UI Testing whose draft is neither logged nor dismissed. */
  untriaged: { ac: number; api: number; ui: number };
  /** Pending drafts from elsewhere: failed test cases, security findings. */
  otherPendingDrafts: number;
};

export type GateResult = { no: number; name: string; met: boolean; reasons: string[] };

/**
 * One computation per release per page render: the board, the release nav and syncStages all ask for it, and
 * React's cache shares the answer within that render. Outside a render (server actions, jobs) it runs every time.
 */
export const computeMetrics = cache((releaseId: string) => computeMetricsNow(releaseId));

async function computeMetricsNow(releaseId: string): Promise<Metrics> {
  const [stories, latest, bugs, runs, escapes, drafts, scan, apiFails, storyFails, protoFails, flowFails, triggerFails] = await Promise.all([
    prisma.story.findMany({ where: { releaseId }, include: { testCases: true, coverage: true } }),
    prisma.build.findFirst({ where: { releaseId }, orderBy: { deployedAt: "desc" }, select: { id: true, number: true } }),
    prisma.bug.findMany({ where: { releaseId } }),
    prisma.automationRun.findMany({ where: { releaseId, source: "playwright" }, orderBy: { ranAt: "desc" }, take: THRESHOLDS.STABILITY_WINDOW }),
    prisma.escape.findMany({ where: { releaseId } }),
    prisma.bugCandidate.findMany({ where: { releaseId }, select: { refKey: true, status: true } }),
    prisma.securityScan.findFirst({ where: { releaseId }, orderBy: { startedAt: "desc" }, select: { status: true, buildNo: true, findings: { where: { result: "Fail", risk: { in: ["High", "Medium"] } }, select: { id: true } } } }),
    prisma.apiTest.findMany({ where: { releaseId, result: "Fail" }, select: { id: true } }),
    prisma.storyFlow.findMany({ where: { releaseId, result: "Mismatch" }, select: { id: true } }),
    prisma.prototype.findMany({ where: { releaseId, matchResult: "Mismatch" }, select: { id: true } }),
    prisma.uiFlow.findMany({ where: { releaseId, result: "Mismatch" }, select: { id: true } }),
    prisma.uiTrigger.findMany({ where: { releaseId, result: "Fail" }, select: { id: true } }),
  ]);
  // Only the latest build counts, and its screenshots are never loaded here: metrics run on every page.
  const [execs, acFails] = latest
    ? await Promise.all([
        prisma.execution.findMany({ where: { buildId: latest.id }, select: { result: true, executedBy: true, humanVerified: true, testCase: { select: { priority: true, smoke: true } } } }),
        prisma.criterionResult.findMany({ where: { buildId: latest.id, result: "Fail" }, select: { id: true } }),
      ])
    : [[], []];

  const cases = stories.flatMap((s) => s.testCases);
  const storiesCovered = stories.filter((s) => s.testCases.length > 0 && !coverageGaps(s.acceptanceCriteria, s.coverage, s.testCases).length).length;
  const casesReviewed = cases.filter((c) => c.reviewed).length;
  const casesApproved = cases.filter((c) => c.approved).length;

  // Every case counts; nothing is approved first.
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

  // Security green comes from the latest scan itself, never from a stage status that a page visit or a person sets.
  const security = securityVerdict(scan ? { status: scan.status, buildNo: scan.buildNo, highOrMedium: scan.findings.length } : null, latest?.number ?? null);
  const triage = untriagedFailures(
    {
      ac: acFails.map((r) => `criterion:${r.id}`),
      api: apiFails.map((t) => `api:${t.id}`),
      ui: [...storyFails.map((f) => `story:${f.id}`), ...protoFails.map((p) => `match:${p.id}`), ...flowFails.map((f) => `flow:${f.id}`), ...triggerFails.map((t) => `trigger:${t.id}`)],
    },
    drafts,
  );

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
    smokeFail: smokeExecs.filter((e) => e.result === "Fail").length,
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
    nfrGreen: security.green,
    securityNote: security.note,
    untriaged: triage.untriaged,
    otherPendingDrafts: triage.otherPendingDrafts,
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

  // Smoke is optional: with nothing flagged there is nothing to pass. Flagging cases in Test case review turns it into a gate.
  const g4: string[] = [];
  if (metrics.smokeTotal && metrics.smokePass < metrics.smokeTotal) g4.push(`smoke ${metrics.smokePass}/${metrics.smokeTotal} passed`);

  const g5 = signoffReasons(metrics, [{ name: "Gate 1", met: !g1.length }, { name: "Gate 2", met: !g2.length }, { name: "Gate 3", met: !g3.length }, { name: "Gate 4", met: !g4.length }]);

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
