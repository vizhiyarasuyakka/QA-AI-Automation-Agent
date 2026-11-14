import type { Metrics } from "./workflow";

export const THRESHOLDS = {
  P1_PASS_RATE: 0.95,
  AUTOMATION_STABILITY: 0.95,
  AUTOMATION_COVERAGE: 0.8,
  REOPEN_RATE_MAX: 0.1,
  MTTF_HIGH_HOURS: 24,
  STABILITY_WINDOW: 10,
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Gate 5, from live numbers only. A failure anywhere in testing blocks Go until a person has triaged it: logged as a
 * bug (then its severity decides) or dismissed with the draft. Nothing here reads a stage status a person can set.
 */
export function signoffReasons(
  m: Pick<Metrics, "openBySeverity" | "openHighWithoutWorkaround" | "passRate" | "progress" | "humanVerifiedRate" | "p1AiExecuted" | "p1HumanVerified" | "nfrGreen" | "securityNote" | "runsConsidered" | "automationStability" | "untriaged" | "otherPendingDrafts">,
  earlier: { name: string; met: boolean }[],
): string[] {
  const out: string[] = [];
  for (const g of earlier) if (!g.met) out.push(`${g.name} not met`);
  if (m.openBySeverity.Critical) out.push(`${m.openBySeverity.Critical} Critical open`);
  if (m.openHighWithoutWorkaround) out.push(`${m.openHighWithoutWorkaround} High open without workaround`);
  if (m.passRate.P1 < THRESHOLDS.P1_PASS_RATE) out.push(`P1 pass rate ${(m.passRate.P1 * 100).toFixed(0)}% below ${THRESHOLDS.P1_PASS_RATE * 100}%`);
  if (m.progress < 1) out.push(`execution ${(m.progress * 100).toFixed(0)}% of planned`);
  if (m.humanVerifiedRate < 1) out.push(`${m.p1AiExecuted - m.p1HumanVerified} AI-executed P1 cases not human-verified`);
  if (m.untriaged.ac) out.push(`AC Check: ${plural(m.untriaged.ac, "failed criterion", "failed criteria")} not logged as a bug or dismissed`);
  if (m.untriaged.api) out.push(`API Test: ${plural(m.untriaged.api, "failed test")} not logged as a bug or dismissed`);
  if (m.untriaged.ui) out.push(`UI Testing: ${plural(m.untriaged.ui, "difference")} from the prototype or stories not logged as a bug or dismissed`);
  if (m.otherPendingDrafts) out.push(`${plural(m.otherPendingDrafts, "bug draft")} waiting in Bugs and reports: log or dismiss each`);
  if (!m.nfrGreen) out.push(`security testing not green: ${m.securityNote}`);
  if (m.runsConsidered && m.automationStability < THRESHOLDS.AUTOMATION_STABILITY) out.push(`automation stability ${(m.automationStability * 100).toFixed(0)}%`);
  return out;
}

/** The latest scan decides. It must have finished, on the build being signed off, with nothing High or Medium failing. */
export function securityVerdict(scan: { status: string; buildNo: string; highOrMedium: number } | null, latestBuild: string | null): { green: boolean; note: string } {
  if (!scan) return { green: false, note: "no security scan has run" };
  if (scan.status === "Running") return { green: false, note: "the security scan is still running" };
  if (scan.status !== "Done") return { green: false, note: "the last security scan did not finish" };
  if (scan.highOrMedium) return { green: false, note: `${plural(scan.highOrMedium, "High or Medium finding")} on the latest scan` };
  if (latestBuild && scan.buildNo && scan.buildNo !== latestBuild) return { green: false, note: `the latest scan is of build ${scan.buildNo}, not ${latestBuild}; scan again` };
  return { green: true, note: "latest scan has nothing High or Medium" };
}

/** Failures whose draft was neither logged nor dismissed, counted by the step they came from. */
export function untriagedFailures(failing: { ac: string[]; api: string[]; ui: string[] }, drafts: { refKey: string; status: string }[]) {
  const status = new Map(drafts.map((d) => [d.refKey, d.status]));
  const open = (keys: string[]) => keys.filter((k) => !["Logged", "Dismissed"].includes(status.get(k) ?? "")).length;
  const counted = new Set([...failing.ac, ...failing.api, ...failing.ui]);
  return {
    untriaged: { ac: open(failing.ac), api: open(failing.api), ui: open(failing.ui) },
    otherPendingDrafts: drafts.filter((d) => d.status === "Pending" && !counted.has(d.refKey)).length,
  };
}
