import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ReleaseNav } from "@/components/ReleaseNav";
import { Notice } from "@/components/Notice";
import { Badge } from "@/components/Badge";
import { ConfirmButton } from "@/components/ConfirmButton";
import { JobPanel } from "@/components/JobPanel";
import { PendingButton } from "@/components/PendingButton";
import { parseCriteria } from "@/lib/coverage";
import { prdsForCase } from "@/lib/execview";
import { runningJob } from "@/lib/jobs";
import { isLocalAddress } from "@/lib/testurl";
import { addCriteria, fetchCriteria, recordCriterion, runAllCriteria, saveTestUrl, testCriteriaInChrome } from "./actions";

export const dynamic = "force-dynamic";

export default async function ExecutionPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; err?: string; story?: string }> }) {
  const { id } = await params; const sp = await searchParams;
  const release = await prisma.release.findUnique({ where: { id } });
  if (!release) notFound();
  // The current build holds the URL to test, the sign-in for it, and the results.
  const build = await prisma.build.findFirst({ where: { releaseId: id }, orderBy: { deployedAt: "desc" } });
  const [prdDocs, stories, acResults, chromeJob, running] = await Promise.all([
    prisma.document.findMany({ where: { releaseId: id, docType: "PRD", status: "Ready" }, select: { fileName: true, module: true }, orderBy: { fileName: "asc" } }),
    prisma.story.findMany({ where: { releaseId: id }, orderBy: [{ module: "asc" }, { storyId: "asc" }], include: { testCases: { select: { sourceRef: true, module: true } } } }),
    build ? prisma.criterionResult.findMany({ where: { buildId: build.id } }) : Promise.resolve([]),
    prisma.generationJob.findFirst({ where: { releaseId: id, kind: { in: ["criteria", "chrome"] } }, orderBy: { startedAt: "desc" } }),
    runningJob(id),
  ]);
  const storyModules = [...new Set(stories.map((s) => s.module))].map((m) => [m, stories.filter((s) => s.module === m)] as const);
  const chosenStory = stories.find((s) => s.id === sp.story);
  const resultOf = (storyId: string, criterion: string) => acResults.find((r) => r.storyId === storyId && r.criterion === criterion);
  const criteriaBy = new Map(stories.map((s) => [s.id, parseCriteria(s.acceptanceCriteria)]));
  const totalCriteria = [...criteriaBy.values()].reduce((a, l) => a + l.length, 0);
  const storiesWithCriteria = [...criteriaBy.values()].filter((l) => l.length).length;
  const notPassed = stories.reduce((a, s) => a + (criteriaBy.get(s.id) ?? []).filter((c) => resultOf(s.id, c.id)?.result !== "Pass").length, 0);
  const listNote = (s: (typeof stories)[number]) => {
    const acs = criteriaBy.get(s.id) ?? [];
    if (!acs.length) return "No criteria yet";
    const passed = acs.filter((c) => resultOf(s.id, c.id)?.result === "Pass").length;
    const failed = acs.filter((c) => resultOf(s.id, c.id)?.result === "Fail").length;
    return `${passed} of ${acs.length} passed${failed ? `, ${failed} failed` : ""}`;
  };
  const chosenCriteria = chosenStory ? criteriaBy.get(chosenStory.id) ?? [] : [];
  const chosenPrds = chosenStory ? [...new Set(chosenStory.testCases.flatMap((c) => prdsForCase(c, prdDocs)).concat(prdsForCase({ sourceRef: "", module: chosenStory.module }, prdDocs)))] : [];
  const tone = (r?: string) => (r === "Pass" ? "ok" : r === "Fail" ? "bad" : r === "Blocked" ? "warn" : undefined);
  const local = !!build && isLocalAddress(build.envUrl);
  const allWarning = "It runs one story after another and takes about two minutes for every few criteria, uses your Claude plan, and positive checks can create records in the app. Results are kept as they come.";

  return (
    <>
      <h1>{release.name}: test execution</h1>
      <p className="muted">Step 4. Enter the URL to test and the sign-in for it, then check every acceptance criterion at once, or choose a user story and check its criteria one by one. Chrome opens the URL, signs in when the app asks, and Claude confirms each criterion the positive way. A criterion can also be marked by hand.</p>
      <ReleaseNav releaseId={id} active="execution" />
      <Notice searchParams={sp} />

      <form action={saveTestUrl} className="card stack" style={{ marginBottom: "1rem" }}>
        <input type="hidden" name="releaseId" value={id} /><input type="hidden" name="storyId" value={chosenStory?.id ?? ""} />
        <h3 style={{ margin: 0 }}>Where to test</h3>
        <label>
          <span className="req">URL to test</span>
          <input name="url" type="url" defaultValue={build?.envUrl ?? ""} placeholder="http://localhost:3000/dashboard" aria-label="URL to test" required />
        </label>
        <div className="fields">
          <label><span>Sign-in user name</span><input name="loginUser" defaultValue={build?.loginUser ?? ""} placeholder="Test account, if the app asks" autoComplete="off" /></label>
          <label><span>Sign-in password</span><input name="loginPassword" type="password" placeholder={build?.loginPassword ? "Saved. Leave blank to keep it" : "Password"} autoComplete="new-password" /></label>
        </div>
        <div className="row">
          <button type="submit" className="small secondary">Save URL and sign-in</button>
          <ConfirmButton className="small" formAction={runAllCriteria} name="scope" value="all" busy="Starting..." disabled={!!running || !totalCriteria} message={`Check all ${totalCriteria} acceptance criteria of ${storiesWithCriteria} stories? ${allWarning}`}>Run all {totalCriteria} criteria</ConfirmButton>
          <ConfirmButton className="small secondary" formAction={runAllCriteria} name="scope" value="open" busy="Starting..." disabled={!!running || !notPassed || notPassed === totalCriteria} message={`Check the ${notPassed} acceptance criteria that have not passed yet? ${allWarning}`}>Run the {notPassed} not passed</ConfirmButton>
          {running && <span className="muted">Another run is in progress.</span>}
        </div>
        <span className="muted" style={{ fontSize: "12px" }}>Claude signs in with the test account only when the app asks, on its own sign-in page. It is sent to Claude with each run and kept in this app's database on this machine; clear the user name to forget it.{local ? " This is a local address, which Claude in Chrome cannot open, so the run opens a Chrome window of its own on this machine." : ""}</span>
      </form>
      <JobPanel job={chromeJob} />

      {!stories.length ? (
        <div className="card muted" style={{ marginBottom: "1rem" }}>No user stories yet. <Link href={`/releases/${id}/stories`}>Load them in step 2</Link>; they appear here.</div>
      ) : (
        <div className="split" style={{ marginBottom: "1rem" }}>
          <nav className="card split-list" aria-label="User stories">
            {storyModules.map(([module, list]) => (
              <div key={module} className="split-group">
                <strong>{module}</strong>
                {list.map((s) => (
                  <Link key={s.id} href={`/releases/${id}/execution?story=${s.id}`} className={`split-item ${s.id === chosenStory?.id ? "active" : ""}`} aria-current={s.id === chosenStory?.id ? "page" : undefined}>
                    <span className="split-title">{s.storyId} {s.title}</span>
                    <span className="muted split-meta">{listNote(s)}</span>
                  </Link>
                ))}
              </div>
            ))}
          </nav>

          <div style={{ minWidth: 0 }}>
            {!chosenStory ? (
              <div className="card muted" style={{ marginBottom: "1rem" }}>Choose a user story to see its acceptance criteria and check them one by one.</div>
            ) : (
              <form action={testCriteriaInChrome} className="card stack" style={{ marginBottom: "1rem" }}>
                <input type="hidden" name="releaseId" value={id} /><input type="hidden" name="storyId" value={chosenStory.id} />
                <div className="row spread">
                  <h3 style={{ margin: 0 }}>{chosenStory.storyId}: {chosenStory.title}</h3>
                  <button type="submit" name="all" value="1" disabled={!!running || !chosenCriteria.length || !build?.envUrl}>Run all {chosenCriteria.length} of this story</button>
                </div>
                <div className="muted">{chosenStory.module}{chosenPrds.length ? `, ${chosenPrds.join(", ")}` : ""}{chosenStory.userStory ? `. ${chosenStory.userStory}` : ""}</div>
                {!build?.envUrl && <span className="muted">Enter the URL to test above and save it first.</span>}
                {!chosenCriteria.length ? (
                  <div className="row">
                    <span className="muted">This story has no acceptance criteria yet.</span>
                    <PendingButton className="small" formAction={fetchCriteria} busy="Fetching...">Fetch acceptance criteria</PendingButton>
                    <span className="muted" style={{ fontSize: "12px" }}>Reads them from your user stories file with one Claude request, or type them below.</span>
                  </div>
                ) : (
                  <div className="tbox">
                    <table>
                      <thead><tr><th>Acceptance criterion ({chosenCriteria.length})</th><th>Result</th><th></th><th>Mark by hand</th></tr></thead>
                      <tbody>
                        {chosenCriteria.map((c) => {
                          const r = resultOf(chosenStory.id, c.id);
                          return (
                            <tr key={c.id}>
                              <td style={{ minWidth: 220 }}><strong>{c.id}</strong> {c.text}</td>
                              <td style={{ minWidth: 160 }}>
                                <Badge tone={tone(r?.result)}>{r?.result ?? "Not run"}</Badge>
                                {r && <div className="muted" style={{ fontSize: "12px" }}>{r.executedBy === "AI" ? "Claude" : "By hand"}{r.actual && r.executedBy === "AI" ? `: ${r.actual}` : ""}</div>}
                              </td>
                              <td><button type="submit" className="small secondary" name="criterion" value={c.id} disabled={!!running || !build?.envUrl} aria-label={`Run ${c.id} in Chrome`}>Run</button></td>
                              <td style={{ whiteSpace: "nowrap" }}>
                                <select name={`result:${c.id}`} defaultValue={r?.result ?? "Pass"} aria-label={`Result of ${c.id}`} style={{ width: "auto" }}>{["Pass", "Fail", "Blocked"].map((x) => <option key={x}>{x}</option>)}</select>
                                <button type="submit" className="small secondary" formAction={recordCriterion} name="criterion" value={c.id} style={{ marginLeft: ".3rem" }}>Save</button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                <label>
                  <span>Add acceptance criteria by hand</span>
                  <textarea name="newCriteria" rows={2} placeholder={"One per line, for example:\nThe Client BOQ list shows the newly registered BOQ"} />
                </label>
                <div><button type="submit" className="small secondary" formAction={addCriteria}>Add criteria</button> <span className="muted" style={{ fontSize: "12px" }}>Numbered after the last one, AC{chosenCriteria.reduce((m, c) => Math.max(m, Number(c.id.slice(2)) || 0), 0) + 1} onwards.</span></div>
                {running
                  ? <span className="muted">Another run is in progress.</span>
                  : <span className="muted">Each criterion is checked the positive way: Claude follows the normal path with valid input and confirms it holds. A failure goes to Bugs and reports as a draft.</span>}
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
