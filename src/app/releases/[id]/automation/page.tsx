import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ReleaseNav } from "@/components/ReleaseNav";
import { Notice } from "@/components/Notice";
import { Badge } from "@/components/Badge";
import { ConfirmButton } from "@/components/ConfirmButton";
import { EnginePicker } from "@/components/EnginePicker";
import { JobPanel } from "@/components/JobPanel";
import { flowStates } from "@/lib/flows";
import { runningJob } from "@/lib/jobs";
import { addRun, deleteRun } from "../execution/actions";
import { THRESHOLDS, pct } from "@/lib/workflow";
import { deleteScript, runScripts, saveScript, triggerScripts } from "./actions";

export const dynamic = "force-dynamic";

export default async function AutomationPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; err?: string; info?: string }> }) {
  const { id } = await params; const sp = await searchParams;
  const release = await prisma.release.findUnique({ where: { id } });
  if (!release) notFound();
  const running = await runningJob(id);
  const runs = await prisma.automationRun.findMany({ where: { releaseId: id }, orderBy: { ranAt: "desc" }, take: 20 });
  const pwRuns = runs.filter((r) => r.source === "playwright").slice(0, THRESHOLDS.STABILITY_WINDOW);
  const stab = pwRuns.reduce((a, r) => a + r.total, 0) ? pwRuns.reduce((a, r) => a + r.passed, 0) / pwRuns.reduce((a, r) => a + r.total, 0) : 0;
  const [scripts, job, states, total, current] = await Promise.all([
    prisma.automationScript.findMany({ where: { releaseId: id }, orderBy: { fileName: "asc" }, include: { story: { select: { storyId: true, title: true } } } }),
    prisma.generationJob.findFirst({ where: { releaseId: id, kind: { in: ["playwright", "pw-run"] } }, orderBy: { startedAt: "desc" } }),
    flowStates(id),
    prisma.testCase.count({ where: { story: { releaseId: id } } }),
    prisma.build.findFirst({ where: { releaseId: id }, orderBy: { deployedAt: "desc" }, select: { number: true, envUrl: true, loginUser: true } }),
  ]);

  return (
    <>
      <h1>{release.name}: Playwright scripts</h1>
      <p className="muted">Step 6. Turns the test cases from step 2 into stored Playwright specs and runs them here. Each test title carries its TC ID, so every result goes back to its case.</p>
      <ReleaseNav releaseId={id} active="automation" />
      <Notice searchParams={sp} />

      <div className="card" style={{ marginBottom: "1rem" }}>
        <div className="row spread"><strong>Playwright flow status</strong><Badge tone={states.playwright.tone}>{states.playwright.status}</Badge></div>
        <p className="muted" style={{ margin: ".4rem 0 0" }}>{states.playwright.detail}</p>
      </div>

      <div className="grid-2" style={{ marginBottom: "1rem" }}>
        <div className="card">
          <h3>Generate scripts</h3>
          <EnginePicker flow="playwright" back={`/releases/${id}/automation`} />
          <form action={triggerScripts} className="stack">
            <input type="hidden" name="releaseId" value={id} />
            <div><button type="submit" disabled={!total || !!running}>Generate Playwright scripts</button></div>
            <span className="muted" style={{ fontSize: ".82rem" }}>Generating again replaces the stored scripts of those stories, including hand edits. Lines marked // VERIFY are guesses to check against the real screen.</span>
          </form>
        </div>
        <div className="card">
          <h3>Run them</h3>
          <form action={runScripts} className="stack" style={{ marginBottom: ".9rem" }}>
            <input type="hidden" name="releaseId" value={id} />
            <div><ConfirmButton busy="Starting..." disabled={!scripts.length || !current?.envUrl || !!running} message={`Run all ${scripts.length} script files on ${current?.envUrl}? Positive tests can create records in that app.`}>Run the scripts here</ConfirmButton></div>
            <span className="muted" style={{ fontSize: ".82rem" }}>{!scripts.length ? "Generate the scripts first." : !current?.envUrl ? "Enter the URL to test in step 4 first." : `Playwright Test runs them in a hidden Chrome on ${new URL(current.envUrl).origin}${current.loginUser ? `, signing in as ${current.loginUser}` : ""}. Results go to each test case and to Recent runs below.`}</span>
          </form>
          <p className="muted" style={{ fontSize: ".82rem" }}>Or run them in your own project or CI:</p>
          <p><a className="btn small secondary" href={`/releases/${id}/automation/download`}>Download all as .zip</a> <span className="muted">Includes a playwright.config.ts.</span></p>
          <pre className="block" style={{ whiteSpace: "pre-wrap" }}>{`npm install -D @playwright/test
npx playwright install chromium
BASE_URL=https://your-qa-url npx playwright test

curl -X POST http://localhost:3100/api/import/playwright \\
  -H "Content-Type: application/json" \\
  -H "X-Release: ${release.name}" -H "X-Build: ${current?.number ?? "<enter the URL to test in step 4 first>"}" \\
  --data-binary @results.json`}</pre>
        </div>
      </div>

      <JobPanel job={job} />

      <h2>Stored scripts ({scripts.length})</h2>
      <div className="card">
        <div className="tbox">
          <table>
            <thead><tr><th>File</th><th>Story</th><th>Cases</th><th>Status</th><th>Generated</th><th></th></tr></thead>
            <tbody>
              {scripts.map((s) => (
                <tr key={s.id}>
                  <td className="mono">{s.fileName}
                    <details><summary className="muted" style={{ fontSize: ".78rem" }}>view or edit</summary>
                      <form action={saveScript} className="stack" style={{ marginTop: ".4rem" }}>
                        <input type="hidden" name="id" value={s.id} /><input type="hidden" name="releaseId" value={id} />
                        <textarea name="code" defaultValue={s.code} className="mono" spellCheck={false} style={{ minHeight: "22rem", minWidth: "min(56rem, 80vw)" }} />
                        <div><button className="small secondary" type="submit">Save edits</button></div>
                      </form>
                    </details>
                  </td>
                  <td>{s.story.storyId}<div className="muted">{s.story.title}</div></td>
                  <td>{s.tcIds.split(",").filter(Boolean).length}</td>
                  <td><Badge tone={s.status === "Ready" ? "ok" : s.status === "Syntax error" ? "bad" : "warn"}>{s.status}</Badge>{s.edited && <div className="muted">edited</div>}{s.error && <div className="muted">{s.error}</div>}</td>
                  <td>{s.generatedAt.toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" })}<div className="muted">{s.engine}</div></td>
                  <td>
                    <a className="btn small secondary" href={`/releases/${id}/automation/download?script=${s.id}`}>Download</a>
                    <form action={deleteScript} className="inline-form"><input type="hidden" name="id" value={s.id} /><input type="hidden" name="releaseId" value={id} /><button className="small secondary" style={{ marginLeft: ".3rem" }}>Remove</button></form>
                  </td>
                </tr>
              ))}
              {!scripts.length && <tr><td colSpan={6} className="muted">No scripts stored yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <h2>Automation runs <span className="muted" style={{ fontWeight: 400 }}>stability {pct(stab)} over last {pwRuns.length} Playwright runs, threshold {pct(THRESHOLDS.AUTOMATION_STABILITY)}</span></h2>
      <div className="grid-2">
        <div className="card">
          <h3>Record a run by hand</h3>
          <form action={addRun} className="stack">
            <input type="hidden" name="releaseId" value={id} />
            <div className="fields">
              <label><span>Source</span><select name="source" defaultValue="playwright"><option>playwright</option><option>newman</option><option>k6</option><option>zap</option><option>axe</option></select></label>
              <label><span>Label</span><input name="runLabel" placeholder="CI #412, nightly" /></label>
              <label><span>Passed</span><input name="passed" type="number" min={0} defaultValue={0} /></label>
              <label><span>Failed</span><input name="failed" type="number" min={0} defaultValue={0} /></label>
              <label><span>Flaky</span><input name="flaky" type="number" min={0} defaultValue={0} /></label>
              <label><span>Skipped</span><input name="skipped" type="number" min={0} defaultValue={0} /></label>
              <label><span>Duration (s)</span><input name="durationSec" type="number" min={0} defaultValue={0} /></label>
            </div>
            <div><button type="submit" className="secondary">Add run</button></div>
          </form>
          <p className="muted" style={{ marginTop: ".75rem" }}>Or post results from CI: <code>POST /api/import/playwright</code> with the Playwright JSON reporter output, <code>POST /api/import/newman</code> with Newman JSON. Add <code>X-Release: {release.name}</code>, optional <code>X-Build</code> and <code>X-Import-Token</code> headers.</p>
        </div>
        <div className="card">
          <h3>Recent runs</h3>
          <div className="tbox">
            <table>
              <thead><tr><th>When</th><th>Source</th><th>Label</th><th>Passed</th><th>Failed</th><th>Flaky</th><th>Total</th><th>Share</th><th></th></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}><td>{r.ranAt.toLocaleString("en-IN")}</td><td>{r.source}</td><td>{r.runLabel}</td><td>{r.passed}</td><td>{r.failed}</td><td>{r.flaky}</td><td>{r.total}</td><td className={r.total && r.passed / r.total < THRESHOLDS.AUTOMATION_STABILITY ? "bad" : "ok"}>{r.total ? pct(r.passed / r.total) : ""}</td>
                    <td><form action={deleteRun} className="inline-form"><input type="hidden" name="id" value={r.id} /><input type="hidden" name="releaseId" value={id} /><button className="small secondary">Delete</button></form></td></tr>
                ))}
                {!runs.length && <tr><td colSpan={9} className="muted">No runs yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
