import { notFound } from "next/navigation";
import { atLeast, requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ReleaseNav } from "@/components/ReleaseNav";
import { Notice } from "@/components/Notice";
import { Badge } from "@/components/Badge";
import { computeMetrics, evaluateGates, pct, STAGES, THRESHOLDS } from "@/lib/workflow";
import { saveSignoff } from "./actions";
import { addEscape, toggleEscapeTest } from "../actions";

export const dynamic = "force-dynamic";

export default async function SignoffPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const { id } = await params; const sp = await searchParams;
  const me = await requireRole("Viewer");
  const canSign = atLeast(me.role, "QA Lead");
  const release = await prisma.release.findUnique({ where: { id }, include: { signoff: true, escapes: { orderBy: { loggedAt: "desc" } }, stories: { orderBy: { storyId: "asc" } } } });
  if (!release) notFound();
  const m = await computeMetrics(id);
  const gates = await evaluateGates(id, m);
  const g5 = gates[4];
  const execs = m.latestBuild ? await prisma.execution.findMany({ where: { build: { releaseId: id, number: m.latestBuild } }, select: { lane: true, executedBy: true } }) : [];
  const lanes = ["UI", "API", "Risk", "Exploratory", "NFR"].map((l) => ({ lane: l, ai: execs.filter((e) => e.lane === l && e.executedBy === "AI").length, human: execs.filter((e) => e.lane === l && e.executedBy === "Human").length }));

  const rows: [string, string, string, boolean][] = [
    ["Requirement coverage", pct(m.requirementCoverage), "100%", m.requirementCoverage >= 1],
    ["Test case review rate", pct(m.reviewRate), "100%", m.reviewRate >= 1],
    ["Execution progress", `${pct(m.progress)} (${m.executed}/${m.planned}; blocked ${m.counts.blocked}, not run ${m.counts.notRun})`, "100%", m.progress >= 1],
    ["Pass rate P1 / P2 / P3", `${pct(m.passRate.P1)} / ${pct(m.passRate.P2)} / ${pct(m.passRate.P3)}`, `P1 at least ${pct(THRESHOLDS.P1_PASS_RATE)}`, m.passRate.P1 >= THRESHOLDS.P1_PASS_RATE],
    ["Human-verified rate (P1 run by AI)", `${pct(m.humanVerifiedRate)} (${m.p1HumanVerified}/${m.p1AiExecuted})`, "100%", m.humanVerifiedRate >= 1],
    ["Defect density", `${m.defectDensity.toFixed(2)} bugs per story (${m.bugsTotal}/${m.stories})`, "trend down", true],
    ["Open bugs by severity", `C ${m.openBySeverity.Critical}, H ${m.openBySeverity.High}, M ${m.openBySeverity.Medium}, L ${m.openBySeverity.Low}`, "0 Critical, 0 High", m.openBySeverity.Critical === 0 && m.openBySeverity.High === 0],
    ["Reopen rate", pct(m.reopenRate), `under ${pct(THRESHOLDS.REOPEN_RATE_MAX)}`, m.reopenRate <= THRESHOLDS.REOPEN_RATE_MAX],
    ["Mean time to fix, Critical and High", `${m.mttfHighHours.toFixed(1)} h`, `under ${THRESHOLDS.MTTF_HIGH_HOURS} h`, m.mttfHighHours <= THRESHOLDS.MTTF_HIGH_HOURS],
    ["Automation coverage (P1 regression)", `${pct(m.automationCoverage)} (${m.p1RegressionAutomated}/${m.p1RegressionTotal})`, `at least ${pct(THRESHOLDS.AUTOMATION_COVERAGE)}`, m.automationCoverage >= THRESHOLDS.AUTOMATION_COVERAGE],
    ["Automation stability (last runs)", `${pct(m.automationStability)} over ${m.runsConsidered} runs`, `at least ${pct(THRESHOLDS.AUTOMATION_STABILITY)}`, m.automationStability >= THRESHOLDS.AUTOMATION_STABILITY || m.runsConsidered === 0],
    ["Escaped defects (this release, post-release)", `${m.escapes} (${m.escapesCritical} Critical)`, "0 Critical", m.escapesCritical === 0],
  ];

  const report = `QA SIGN-OFF: ${release.name}
Build: ${m.latestBuild ?? "none"}    Date: ${new Date().toISOString().slice(0, 10)}
Recommendation: ${release.signoff?.recommendation ?? (g5.met ? "Go" : "No-go")}
Gate 5: ${g5.met ? "met" : "NOT met: " + g5.reasons.join("; ")}

Scope tested: ${release.signoff?.scopeTested || release.stories.map((s) => s.storyId).join(", ") || "(none)"}
Scope not tested: ${release.signoff?.scopeNotTested || "(state what was out of scope and why)"}

Numbers
${rows.map(([k, v, t]) => `- ${k}: ${v} (target ${t})`).join("\n")}

AI involvement (latest build)
${lanes.map((l) => `- ${l.lane} lane: ${l.ai} AI-executed, ${l.human} human-executed`).join("\n")}
- AI-executed P1 cases re-run by a person: ${m.p1HumanVerified}/${m.p1AiExecuted}

Risks and workarounds
${release.signoff?.risks || "(none documented)"}

Signed: ${release.signoff?.signedBy || "(not signed yet)"}${release.signoff?.snapshotHash ? `\nSnapshot SHA-256: ${release.signoff.snapshotHash}` : ""}`;

  return (
    <>
      <h1>{release.name}: sign-off and report</h1>
      <p className="muted">Stages 12 and 13. All twelve metrics are always shown; none is dropped because it looks bad. Go is only allowed when Gate 5 is met.</p>
      <ReleaseNav releaseId={id} active="signoff" />
      <Notice searchParams={sp} />

      <div className="card" style={{ marginBottom: "1rem" }}>
        <div className="row spread">
          <h3 style={{ margin: 0 }}>Gate 5 <Badge tone={g5.met ? "ok" : "bad"}>{g5.met ? "Met" : "Not met"}</Badge></h3>
          {release.signoff && <span className="muted">Last sign-off: {release.signoff.recommendation} by {release.signoff.signedBy} on {release.signoff.signedAt.toLocaleString("en-IN")} (build {release.signoff.buildNo}){release.signoff.snapshotHash && <> · <span className="mono" title="SHA-256 of what was signed">{release.signoff.snapshotHash.slice(0, 12)}</span></>}{!release.signoff.signedById && <> · <Badge tone="warn">signed before sign-in existed</Badge></>}</span>}
        </div>
        {!g5.met && <ul style={{ margin: ".4rem 0 0", paddingLeft: "1.2rem" }}>{g5.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
      </div>

      <div className="grid-2">
        <div className="card">
          <h3>The twelve metrics</h3>
          <table>
            <thead><tr><th>Metric</th><th>Value</th><th>Target</th><th></th></tr></thead>
            <tbody>{rows.map(([k, v, t, ok]) => <tr key={k}><td>{k}</td><td>{v}</td><td className="muted">{t}</td><td><Badge tone={ok ? "ok" : "bad"}>{ok ? "ok" : "miss"}</Badge></td></tr>)}</tbody>
          </table>
        </div>
        <div className="card">
          <h3>Record the sign-off</h3>
          <form action={saveSignoff} className="stack">
            <input type="hidden" name="releaseId" value={id} />
            <label><span className="req">Recommendation</span><select name="recommendation" defaultValue={release.signoff?.recommendation ?? (g5.met ? "Go" : "No-go")}><option>Go</option><option>Go with conditions</option><option>No-go</option></select></label>
            <label><span>Scope tested (story IDs)</span><input name="scopeTested" defaultValue={release.signoff?.scopeTested ?? release.stories.map((s) => s.storyId).join(", ")} /></label>
            <label><span>Scope not tested and why</span><textarea name="scopeNotTested" defaultValue={release.signoff?.scopeNotTested ?? ""} /></label>
            <label><span>Risks and workarounds, each with an owner</span><textarea name="risks" defaultValue={release.signoff?.risks ?? ""} /></label>
            {canSign
              ? <p className="muted" style={{ margin: 0 }}>Signing as <strong>{me.name}</strong> ({me.email}, {me.role}). The gates are checked again when you save.</p>
              : <p className="notice warn" style={{ margin: 0 }}>Only a QA Lead or Admin can sign off. You are signed in as {me.role}.</p>}
            <div><button type="submit" disabled={!canSign}>Save sign-off</button></div>
          </form>
        </div>
      </div>

      <h2>Report text (paste into the release thread)</h2>
      <div className="card"><pre className="block">{report}</pre></div>

      <h2>Stage 13: post-release escapes</h2>
      <div className="grid-2">
        <div className="card">
          <h3>Log an escape</h3>
          <form action={addEscape} className="stack">
            <input type="hidden" name="releaseId" value={id} />
            <div className="fields">
              <label><span className="req">Escape ID</span><input name="escapeId" placeholder="ESC-09" required /></label>
              <label><span className="req">Module</span><input name="module" required /></label>
              <label><span>Severity</span><select name="severity" defaultValue="Medium">{["Critical", "High", "Medium", "Low"].map((x) => <option key={x}>{x}</option>)}</select></label>
              <label><span>Stage that should have caught it</span><select name="stageMissed" defaultValue="6 Scripted execution">{STAGES.map((s) => <option key={s.no}>{s.no} {s.name}</option>)}</select></label>
              <label className="full"><span>What happened</span><textarea name="description" /></label>
            </div>
            <div><button type="submit" className="secondary">Log escape</button></div>
          </form>
        </div>
        <div className="card">
          <h3>Escapes ({release.escapes.length})</h3>
          <table>
            <thead><tr><th>ID</th><th>Module</th><th>Sev</th><th>Stage missed</th><th>Logged</th><th>Test added</th></tr></thead>
            <tbody>
              {release.escapes.map((e) => (
                <tr key={e.id}><td className="mono">{e.escapeId}</td><td>{e.module}<div className="muted">{e.description}</div></td><td><Badge tone={e.severity === "Critical" || e.severity === "High" ? "bad" : undefined}>{e.severity}</Badge></td><td>{e.stageMissed}</td><td>{e.loggedAt.toLocaleDateString("en-IN")}</td>
                  <td><form action={toggleEscapeTest} className="inline-form"><input type="hidden" name="id" value={e.id} /><input type="hidden" name="releaseId" value={id} /><button className={`small ${e.testAdded ? "" : "secondary"}`}>{e.testAdded ? "Yes" : "Not yet"}</button></form></td></tr>
              ))}
              {!release.escapes.length && <tr><td colSpan={6} className="muted">No escapes logged. Watch production for 48 hours after release.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
