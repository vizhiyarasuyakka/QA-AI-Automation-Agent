import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ReleaseNav } from "@/components/ReleaseNav";
import { Notice } from "@/components/Notice";
import { Badge, severityTone, statusTone } from "@/components/Badge";
import { createBug, deleteBug, dismissDraft, logDraft, makeDrafts, resendWebhook, sendTestReport, updateBugStatus } from "./actions";
import { EnginePicker } from "@/components/EnginePicker";
import { selectedEngine } from "@/lib/engines";
import { getSetting } from "@/lib/webhook";
import { computeMetrics, pct, THRESHOLDS } from "@/lib/workflow";

export const dynamic = "force-dynamic";

export default async function BugsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; err?: string; status?: string }> }) {
  const { id } = await params; const sp = await searchParams;
  const release = await prisma.release.findUnique({ where: { id } });
  if (!release) notFound();
  const [bugs, stories, builds, m] = await Promise.all([
    prisma.bug.findMany({ where: { releaseId: id }, orderBy: { loggedAt: "desc" }, include: { story: true, testCase: true } }),
    prisma.story.findMany({ where: { releaseId: id }, orderBy: { storyId: "asc" }, include: { testCases: { orderBy: { tcId: "asc" } } } }),
    prisma.build.findMany({ where: { releaseId: id }, orderBy: { deployedAt: "desc" } }),
    computeMetrics(id),
  ]);
  const [drafts, reports, reportTool, engine] = await Promise.all([
    prisma.bugCandidate.findMany({ where: { releaseId: id, status: "Pending" }, orderBy: { createdAt: "asc" } }),
    prisma.reportPush.findMany({ where: { releaseId: id }, orderBy: { sentAt: "desc" }, take: 5 }),
    getSetting("REPORT_MCP_TOOL"),
    selectedEngine("bugs"),
  ]);
  const shown = sp.status ? bugs.filter((b) => b.status === sp.status) : bugs;

  return (
    <>
      <h1>{release.name}: bugs</h1>
      <p className="muted">Step 7. Confirm failures as bugs, send them through your connector, and send the pass and fail report. Reproduce once by hand, then log with every template field. Each bug goes through the connection chosen below.</p>
      <ReleaseNav releaseId={id} active="bugs" />
      <Notice searchParams={sp} />

      <div className="card" style={{ marginBottom: "1rem" }}>
        <h3>Where bugs go</h3>
        <EnginePicker flow="bugs" back={`/releases/${id}/bugs`} />
        <span className="muted" style={{ fontSize: ".82rem" }}>Set up the MCP connector in <a href="/settings">Settings</a>.</span>
      </div>

      <div className="grid-2" style={{ marginBottom: "1rem" }}>
        <div className="card">
          <h3>Bug drafts from failures</h3>
          <p className="muted">Turns failed test cases on the latest build into drafts. Failed acceptance criteria, failed UI triggers and prototype differences arrive here on their own.</p>
          <form action={makeDrafts}><input type="hidden" name="releaseId" value={id} /><button type="submit" disabled={!builds.length}>Create drafts from failed cases</button></form>
        </div>
        <div className="card">
          <h3>Pass and fail report</h3>
          <p className="muted">Sends every test case result on the latest build through the MCP connector{reportTool ? <>, using <code>{reportTool}</code></> : ""}.</p>
          <form action={sendTestReport}><input type="hidden" name="releaseId" value={id} /><button type="submit" disabled={!builds.length || engine !== "mcp" || !reportTool}>Send report through MCP</button></form>
          {(engine !== "mcp" || !reportTool) && <p className="muted" style={{ marginTop: ".5rem" }}>Choose MCP connector above and a report tool in <a href="/settings">Settings</a> first.</p>}
          {reports.map((r) => <div key={r.id} className="muted" style={{ marginTop: ".4rem" }}><Badge tone={r.status === "sent" ? "ok" : "bad"}>{r.status}</Badge> Build {r.buildNo}: {r.passed} passed, {r.failed} failed, {r.blocked} blocked, {r.notRun} not run. {r.sentAt.toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" })}. {r.response.slice(0, 120)}</div>)}
        </div>
      </div>

      {drafts.length > 0 && (
        <>
          <h2>Drafts to confirm ({drafts.length})</h2>
          <div className="card" style={{ marginBottom: "1rem" }}>
            <div className="tbox">
              <table>
                <thead><tr><th>Failure</th><th>From</th><th>Confirm</th></tr></thead>
                <tbody>
                  {drafts.map((d) => (
                    <tr key={d.id}>
                      <td><strong>{d.title}</strong><div className="muted">{d.module}, build {d.buildNo}</div>
                        <details><summary className="muted" style={{ fontSize: ".78rem" }}>details</summary><div style={{ fontSize: ".82rem" }}><div><b>Steps:</b><pre>{d.steps}</pre></div><div><b>Expected:</b> {d.expected}</div><div><b>Actual:</b> {d.actual}</div>{d.evidenceUrl && <div><a href={d.evidenceUrl} target="_blank" rel="noreferrer">Screenshot</a></div>}</div></details>
                      </td>
                      <td>{d.refKey.startsWith("match:") ? "Prototype comparison" : d.refKey.startsWith("criterion:") ? "Acceptance criterion" : d.source === "ui" ? "UI trigger" : "Test case"}</td>
                      <td>
                        <form action={logDraft} className="stack" style={{ minWidth: 220 }}>
                          <input type="hidden" name="id" value={d.id} /><input type="hidden" name="releaseId" value={id} />
                          <select name="severity" defaultValue={d.severity}>{["Critical", "High", "Medium", "Low"].map((x) => <option key={x}>{x}</option>)}</select>
                          <label className="inline"><input type="checkbox" name="reproducedByHuman" /> I reproduced this</label>
                          <button className="small" type="submit">Log bug and send</button>
                        </form>
                        <form action={dismissDraft} className="inline-form"><input type="hidden" name="id" value={d.id} /><input type="hidden" name="releaseId" value={id} /><button className="small secondary" style={{ marginTop: ".3rem" }}>Dismiss</button></form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <div className="tiles">
        <div className="card tile"><p className="label">Open Critical</p><div className={`big ${m.openBySeverity.Critical ? "bad" : "ok"}`}>{m.openBySeverity.Critical}</div></div>
        <div className="card tile"><p className="label">Open High</p><div className={`big ${m.openBySeverity.High ? "bad" : "ok"}`}>{m.openBySeverity.High}</div><p className="sub">{m.openHighWithoutWorkaround} without workaround</p></div>
        <div className="card tile"><p className="label">Open Medium / Low</p><div className="big">{m.openBySeverity.Medium} / {m.openBySeverity.Low}</div></div>
        <div className="card tile"><p className="label">Reopen rate</p><div className={`big ${m.reopenRate <= THRESHOLDS.REOPEN_RATE_MAX ? "ok" : "warn"}`}>{pct(m.reopenRate)}</div><p className="sub">Target under {pct(THRESHOLDS.REOPEN_RATE_MAX)}</p></div>
        <div className="card tile"><p className="label">Mean time to fix, Crit/High</p><div className={`big ${m.mttfHighHours <= THRESHOLDS.MTTF_HIGH_HOURS ? "ok" : "warn"}`}>{m.mttfHighHours.toFixed(1)} h</div><p className="sub">Target under {THRESHOLDS.MTTF_HIGH_HOURS} h</p></div>
        <div className="card tile"><p className="label">Defect density</p><div className="big">{m.defectDensity.toFixed(2)}</div><p className="sub">{m.bugsTotal} bugs / {m.stories} stories</p></div>
      </div>

      <h2>Log a bug</h2>
      <div className="card">
        <form action={createBug} className="stack">
          <input type="hidden" name="releaseId" value={id} />
          <div className="fields">
            <label><span>Bug ID (auto if blank)</span><input name="bugId" placeholder="BUG-315" /></label>
            <label className="full"><span className="req">Title (Module: short symptom, under 80 chars)</span><input name="title" maxLength={80} required /></label>
            <label><span className="req">Module</span><input name="module" required /></label>
            <label><span className="req">Severity (impact, QA owns)</span><select name="severity" defaultValue="Medium">{["Critical", "High", "Medium", "Low"].map((x) => <option key={x}>{x}</option>)}</select></label>
            <label><span>Priority (urgency, PM owns)</span><select name="priority" defaultValue="P2">{["P1", "P2", "P3"].map((x) => <option key={x}>{x}</option>)}</select></label>
            <label><span>Story</span><select name="storyRefId" defaultValue=""><option value="">none</option>{stories.map((s) => <option key={s.id} value={s.id}>{s.storyId} {s.title.slice(0, 40)}</option>)}</select></label>
            <label><span>Test case</span><select name="testCaseRefId" defaultValue=""><option value="">none</option>{stories.flatMap((s) => s.testCases.map((t) => <option key={t.id} value={t.id}>{t.tcId}</option>))}</select></label>
            <label><span className="req">Build number</span><input name="buildNo" list="builds" defaultValue={builds[0]?.number ?? ""} required /><datalist id="builds">{builds.map((b) => <option key={b.id} value={b.number} />)}</datalist></label>
            <label><span>Environment</span><input name="environment" defaultValue="QA" /></label>
            <label><span>Browser / device</span><input name="browser" placeholder="Chrome 131, Windows" /></label>
            <label className="full"><span>Pre-condition (one line)</span><input name="precondition" /></label>
            <label className="full"><span className="req">Steps to reproduce (numbered, one action per line)</span><textarea name="steps" required /></label>
            <label><span>Test data (exact values)</span><input name="testData" /></label>
            <label><span>Evidence URL (screenshot, video, API response)</span><input name="evidenceUrl" placeholder="https://..." /></label>
            <label><span className="req">Expected result</span><textarea name="expected" required /></label>
            <label><span className="req">Actual result</span><textarea name="actual" required /></label>
            <label className="full"><span>Workaround (required to release with an open High)</span><input name="workaround" /></label>
          </div>
          <label className="inline"><input type="checkbox" name="reproducedByHuman" /> Reproduced by a human (mandatory unless severity is Low)</label>
          <label className="inline"><input type="checkbox" name="force" /> Log anyway if a bug with the same module and title exists</label>
          <div><button type="submit">Log bug</button></div>
        </form>
      </div>

      <div className="row" style={{ margin: "1rem 0 .5rem" }}>
        <span className="muted">Status:</span>
        {["", "Open", "In progress", "Fixed", "Reopened", "Closed", "Rejected"].map((st) => <a key={st} href={`/releases/${id}/bugs${st ? `?status=${encodeURIComponent(st)}` : ""}`} className={`btn small ${(sp.status ?? "") === st ? "" : "secondary"}`}>{st || "All"}</a>)}
      </div>
      <div className="card">
        <div className="tbox">
          <table>
            <thead><tr><th>Bug</th><th>Title</th><th>Sev</th><th>Pri</th><th>Status</th><th>Story / TC</th><th>Build</th><th>Logged</th><th>Fixed</th><th>Pushed</th><th>Update</th></tr></thead>
            <tbody>
              {shown.map((b) => (
                <tr key={b.id}>
                  <td className="mono">{b.bugId}</td>
                  <td><strong>{b.title}</strong><div className="muted">{b.module}{b.reproducedByHuman ? "" : " · not reproduced by human"}</div>
                    <details><summary className="muted" style={{ fontSize: ".78rem" }}>details</summary>
                      <div style={{ fontSize: ".82rem" }}>
                        {b.precondition && <div><b>Pre:</b> {b.precondition}</div>}
                        <div><b>Steps:</b><pre>{b.steps}</pre></div>
                        {b.testData && <div><b>Data:</b> {b.testData}</div>}
                        <div><b>Expected:</b> {b.expected}</div><div><b>Actual:</b> {b.actual}</div>
                        {b.evidenceUrl && <div><b>Evidence:</b> <a href={b.evidenceUrl} target="_blank" rel="noreferrer">{b.evidenceUrl}</a></div>}
                        {b.workaround && <div><b>Workaround:</b> {b.workaround}</div>}
                        {b.webhookResponse && <div className="muted">Connector reply: {b.webhookResponse}</div>}
                      </div>
                    </details>
                  </td>
                  <td><Badge tone={severityTone(b.severity)}>{b.severity}</Badge></td>
                  <td>{b.priority}</td>
                  <td><Badge tone={statusTone(b.status)}>{b.status}</Badge>{b.reopenCount > 0 && <div className="muted">reopened {b.reopenCount}x</div>}</td>
                  <td>{b.story?.storyId ?? ""}<div className="mono muted">{b.testCase?.tcId ?? ""}</div></td>
                  <td>{b.buildNo}</td>
                  <td>{b.loggedAt.toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" })}</td>
                  <td>{b.fixedAt ? b.fixedAt.toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" }) : ""}</td>
                  <td><Badge tone={b.webhookStatus === "sent" ? "ok" : b.webhookStatus === "failed" ? "bad" : undefined}>{b.webhookStatus}</Badge>
                    {b.webhookStatus !== "sent" && <form action={resendWebhook} className="inline-form"><input type="hidden" name="id" value={b.id} /><input type="hidden" name="releaseId" value={id} /><button className="small secondary" style={{ marginTop: ".2rem" }}>Resend</button></form>}
                  </td>
                  <td>
                    <form action={updateBugStatus} className="stack" style={{ minWidth: 150 }}>
                      <input type="hidden" name="id" value={b.id} /><input type="hidden" name="releaseId" value={id} />
                      <select name="status" defaultValue={b.status}>{["Open", "In progress", "Fixed", "Reopened", "Closed", "Rejected"].map((x) => <option key={x}>{x}</option>)}</select>
                      <select name="priority" defaultValue={b.priority}>{["P1", "P2", "P3"].map((x) => <option key={x}>{x}</option>)}</select>
                      <input name="workaround" defaultValue={b.workaround} placeholder="Workaround" />
                      <div className="row"><button className="small" type="submit">Save</button></div>
                    </form>
                    <form action={deleteBug} className="inline-form"><input type="hidden" name="id" value={b.id} /><input type="hidden" name="releaseId" value={id} /><button className="small secondary" style={{ marginTop: ".3rem" }}>Delete</button></form>
                  </td>
                </tr>
              ))}
              {!shown.length && <tr><td colSpan={11} className="muted">No bugs here.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <p className="muted" style={{ marginTop: ".75rem" }}>Retest rule (stage 10): a Fixed bug goes back to Reopened if the original steps still fail; never close on the dev's word. Reopened bugs count against the reopen rate.</p>
    </>
  );
}
