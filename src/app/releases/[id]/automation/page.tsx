import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ReleaseNav } from "@/components/ReleaseNav";
import { Notice } from "@/components/Notice";
import Link from "next/link";
import { Badge, resultTone } from "@/components/Badge";
import { ConfirmButton } from "@/components/ConfirmButton";
import { EnginePicker } from "@/components/EnginePicker";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Picture } from "@/components/Picture";

import { flowStates } from "@/lib/flows";
import { runningJob, runProblems } from "@/lib/jobs";
import { deleteScript, runScripts, saveScript, triggerScripts } from "./actions";

export const dynamic = "force-dynamic";

export default async function AutomationPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; err?: string; info?: string; story?: string }> }) {
  const { id } = await params; const sp = await searchParams;
  const release = await prisma.release.findUnique({ where: { id } });
  if (!release) notFound();
  const running = await runningJob(id);
  const [scripts, job, states, total, current] = await Promise.all([
    prisma.automationScript.findMany({ where: { releaseId: id }, orderBy: { fileName: "asc" }, include: { story: { select: { storyId: true, title: true } } } }),
    prisma.generationJob.findFirst({ where: { releaseId: id, kind: { in: ["playwright", "pw-run"] } }, orderBy: { startedAt: "desc" } }),
    flowStates(id),
    prisma.testCase.count({ where: { story: { releaseId: id } } }),
    prisma.build.findFirst({ where: { releaseId: id }, orderBy: { deployedAt: "desc" }, select: { id: true, number: true, envUrl: true, loginUser: true } }),
  ]);
  // Every story with its cases, what the scripts found for each on the latest build, and which cases a stored script covers.
  const stories = await prisma.story.findMany({
    where: { releaseId: id }, orderBy: { storyId: "asc" },
    select: { id: true, storyId: true, title: true, module: true, userStory: true, scripts: { orderBy: { part: "asc" }, select: { id: true, fileName: true, tcIds: true, code: true, status: true, error: true, engine: true, edited: true, editedBy: true, generatedAt: true } }, testCases: { orderBy: { tcId: "asc" }, select: { id: true, tcId: true, title: true, priority: true, expected: true, executions: { where: { buildId: current?.id ?? "" }, select: { id: true, result: true, actual: true, executedAt: true, executedBy: true, evidenceUrl: true } } } } },
  });
  const rowsOf = (s: (typeof stories)[number]) => {
    const covered = new Set(s.scripts.flatMap((x) => x.tcIds.split(",").map((t) => t.trim())));
    return s.testCases.map((c) => ({ ...c, run: c.executions[0] ?? null, scripted: covered.has(c.tcId) }));
  };
  const count = (rows: ReturnType<typeof rowsOf>, r: string) => rows.filter((c) => (c.run?.result ?? "Not run") === r).length;
  const everything = stories.flatMap(rowsOf);
  const storyModules = [...new Map(stories.map((s) => [s.module || "No module", stories.filter((x) => (x.module || "No module") === (s.module || "No module"))])).entries()];
  const chosen = stories.find((s) => s.id === sp.story) ?? null;
  const chosenRows = chosen ? rowsOf(chosen) : [];
  const listNote = (s: (typeof stories)[number]) => {
    const rows = rowsOf(s);
    if (!s.scripts.length) return s.testCases.length ? `${s.testCases.length} cases, no scripts yet` : "no test cases";
    const failed = count(rows, "Fail"), passed = count(rows, "Pass");
    return failed || passed ? `${passed} passed, ${failed} failed, ${count(rows, "Not run")} not run` : `${s.scripts.length} script${s.scripts.length === 1 ? "" : "s"}, not run yet`;
  };

  return (
    <>
      <h1>{release.name}: Playwright Test</h1>
      <p className="muted">Step 5. Turns the test cases from step 2 into stored Playwright specs and runs them here, story by story or one case at a time. Each test title carries its TC ID, so every result goes back to its case with its screenshot.</p>
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
            <span className="muted" style={{ fontSize: ".82rem" }}>{!scripts.length ? "Generate the scripts first." : !current?.envUrl ? "Enter the URL to test in step 4 first." : `Playwright Test runs them in a hidden Chrome on ${new URL(current.envUrl).origin}${current.loginUser ? `, signing in as ${current.loginUser}` : ""}. Results go to each test case below.`}</span>
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

      {running && (running.kind === "playwright" || running.kind === "pw-run") ? (
        <div className="card loader" role="status" style={{ marginBottom: "1rem" }}>
          <AutoRefresh />
          <span className="spinner" aria-hidden="true" />
          <div>
            <strong>{running.kind === "playwright" ? "Writing the Playwright scripts" : "Running the scripts"}</strong>
            <div className="muted">{running.phase}.{running.storiesTotal ? ` ${running.storiesDone} of ${running.storiesTotal} done.` : ""} Results show below as soon as they are saved. You can leave this page; it keeps running.</div>
          </div>
        </div>
      ) : job && (job.status === "Failed" || runProblems(job.log).length > 0) ? (
        <div className="notice warn" style={{ marginBottom: "1rem" }}>
          <strong>{job.status === "Failed" ? "The last run failed." : "The last run finished with problems."}</strong>
          {runProblems(job.log).slice(0, 5).map((p, i) => <div key={i} style={{ overflowWrap: "anywhere" }}>{p}</div>)}
        </div>
      ) : null}

      <h2>Run by user story <span className="muted" style={{ fontWeight: 400 }}>on build {current?.number ?? "none"}: {count(everything, "Pass")} passed, {count(everything, "Fail")} failed, {count(everything, "Blocked")} blocked, {count(everything, "Not run")} not run</span></h2>
      {!stories.length ? (
        <div className="card muted" style={{ marginBottom: "1rem" }}>No user stories yet. <Link href={`/releases/${id}/stories`}>Load them in step 2</Link>; they appear here.</div>
      ) : (
        <div className="split" style={{ marginBottom: "1rem" }}>
          <nav className="card split-list" aria-label="User stories">
            {storyModules.map(([module, list]) => (
              <div key={module} className="split-group">
                <strong>{module}</strong>
                {list.map((s) => (
                  <Link key={s.id} href={`/releases/${id}/automation?story=${s.id}`} className={`split-item ${s.id === chosen?.id ? "active" : ""}`} aria-current={s.id === chosen?.id ? "page" : undefined}>
                    <span className="split-title">{s.storyId} {s.title}</span>
                    <span className="muted split-meta">{listNote(s)}</span>
                  </Link>
                ))}
              </div>
            ))}
          </nav>

          <div style={{ minWidth: 0 }}>
            {!chosen ? (
              <div className="card muted" style={{ marginBottom: "1rem" }}>Choose a user story to see its test cases, generate its scripts, and run them: the whole story, or one case at a time. Run the scripts here, above, runs every story.</div>
            ) : (
              <div className="card stack" style={{ marginBottom: "1rem" }}>
                <div className="row spread" style={{ alignItems: "flex-start" }}>
                  <div>
                    <h3 style={{ margin: 0 }}>{chosen.storyId}: {chosen.title}</h3>
                    <div className="muted">{chosen.module}{chosen.userStory ? `. ${chosen.userStory}` : ""}</div>
                  </div>
                  <div className="row" style={{ flexWrap: "wrap", gap: ".4rem" }}>
                    <form action={triggerScripts} className="inline-form">
                      <input type="hidden" name="releaseId" value={id} /><input type="hidden" name="story" value={chosen.id} />
                      {chosen.scripts.length ? <ConfirmButton className="small secondary" message={`Write the scripts for ${chosen.storyId} again? Its stored scripts, including hand edits, are replaced.`} busy="Starting..." disabled={!!running || !chosen.testCases.length}>Write its scripts again</ConfirmButton> : <button type="submit" className="small" disabled={!!running || !chosen.testCases.length}>Generate scripts for this story</button>}
                    </form>
                    <form action={runScripts} className="inline-form">
                      <input type="hidden" name="releaseId" value={id} /><input type="hidden" name="story" value={chosen.id} /><input type="hidden" name="scope" value="story" />
                      <ConfirmButton className="small" message={`Run ${chosen.storyId}'s ${chosen.scripts.length} script file${chosen.scripts.length === 1 ? "" : "s"} on ${current?.envUrl}? Positive tests can create records in that app.`} busy="Starting..." disabled={!!running || !chosen.scripts.length || !current?.envUrl}>Run this story</ConfirmButton>
                    </form>
                  </div>
                </div>
                {!chosen.scripts.length && <span className="muted">No scripts for this story yet{chosen.testCases.length ? ": generate them, then run the story or one case." : ": it has no test cases to write them from."}</span>}
                {!current?.envUrl && <span className="muted">Enter the URL to test in AC Check first; the scripts run against it.</span>}
                <div className="tbox">
                  <table>
                    <thead><tr><th>Test case</th><th>Expected</th><th>Result</th><th>What happened</th><th>Evidence</th></tr></thead>
                    <tbody>
                      {chosenRows.map((r) => (
                        <tr key={r.id}>
                          <td style={{ minWidth: 220 }}>
                            <span className="mono">{r.tcId}</span> <span className="muted">{r.priority}</span><div>{r.title}</div>
                            {!r.scripted && chosen.scripts.length > 0 && <div className="muted" style={{ fontSize: 11 }}>Not in the stored scripts</div>}
                            <form action={runScripts} className="inline-form" style={{ marginTop: ".3rem" }}>
                              <input type="hidden" name="releaseId" value={id} /><input type="hidden" name="story" value={chosen.id} /><input type="hidden" name="scope" value="case" /><input type="hidden" name="tcId" value={r.tcId} />
                              <button type="submit" className="small secondary" disabled={!!running || !r.scripted || !current?.envUrl} aria-label={`Run ${r.tcId}`} title={r.scripted ? `Run only ${r.tcId}` : "No stored script has a test for this case"}>Run this case</button>
                            </form>
                          </td>
                          <td className="muted" style={{ fontSize: 13, minWidth: 180 }}>{r.expected}</td>
                          <td><Badge tone={resultTone(r.run?.result ?? "Not run")}>{r.run?.result ?? "Not run"}</Badge>{r.run && r.run.result !== "Not run" && <div className="muted" style={{ fontSize: 11 }}>{r.run.executedBy === "AI" ? "Playwright" : "By hand"}, {r.run.executedAt.toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" })}</div>}</td>
                          <td style={{ fontSize: 13, minWidth: 200, overflowWrap: "anywhere" }}>{r.run?.actual}</td>
                          <td>{r.run?.evidenceUrl ? <Picture small href={r.run.evidenceUrl} alt={`Screen at the end of ${r.tcId}`} /> : <span className="muted">None yet</span>}</td>
                        </tr>
                      ))}
                      {!chosenRows.length && <tr><td colSpan={5} className="muted">No test cases for this story yet.</td></tr>}
                    </tbody>
                  </table>
                </div>
                {count(chosenRows, "Fail") > 0 && <Link href={`/releases/${id}/bugs`}>Confirm the failures in Bugs and reports</Link>}
                {chosen.scripts.length > 0 && (
                  <details>
                    <summary className="muted" style={{ cursor: "pointer" }}>Its script files ({chosen.scripts.length}): view, edit, download or remove</summary>
                    <table style={{ marginTop: ".5rem" }}>
                      <thead><tr><th>File</th><th>Cases</th><th>Status</th><th>Generated</th><th></th></tr></thead>
                      <tbody>
                        {chosen.scripts.map((s) => (
                          <tr key={s.id}>
                            <td className="mono">{s.fileName}
                              <details><summary className="muted" style={{ fontSize: ".78rem" }}>view or edit</summary>
                                <form action={saveScript} className="stack" style={{ marginTop: ".4rem" }}>
                                  <input type="hidden" name="id" value={s.id} /><input type="hidden" name="releaseId" value={id} />
                                  <textarea name="code" defaultValue={s.code} className="mono" spellCheck={false} style={{ minHeight: "22rem", minWidth: "min(48rem, 70vw)" }} />
                                  <div><button className="small secondary" type="submit">Save edits</button></div>
                                </form>
                              </details>
                            </td>
                            <td>{s.tcIds.split(",").filter(Boolean).length}</td>
                            <td><Badge tone={s.status === "Ready" ? "ok" : s.status === "Syntax error" || s.status === "Blocked by policy" ? "bad" : "warn"}>{s.status}</Badge>{s.edited && <div className="muted">edited{s.editedBy ? ` by ${s.editedBy}` : ""}</div>}{s.error && <div className="muted">{s.error}</div>}</td>
                            <td>{s.generatedAt.toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" })}<div className="muted">{s.engine}</div></td>
                            <td style={{ whiteSpace: "nowrap" }}>
                              <a className="btn small secondary" href={`/releases/${id}/automation/download?script=${s.id}`}>Download</a>{" "}
                              <form action={deleteScript} className="inline-form"><input type="hidden" name="id" value={s.id} /><input type="hidden" name="releaseId" value={id} /><ConfirmButton className="small secondary" message={`Remove ${s.fileName}?`} busy="Removing...">Remove</ConfirmButton></form>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                )}
              </div>
            )}
          </div>
        </div>
      )}

    </>
  );
}
