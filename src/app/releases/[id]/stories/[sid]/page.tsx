import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ReleaseNav } from "@/components/ReleaseNav";
import { Notice } from "@/components/Notice";
import { Badge } from "@/components/Badge";
import { JobLoader } from "@/components/JobLoader";
import { ConfirmButton } from "@/components/ConfirmButton";
import { EnginePicker } from "@/components/EnginePicker";
import { coverageGaps, parseCriteria } from "@/lib/coverage";
import { runningJob } from "@/lib/jobs";
import { addCase, bulkCaseAction, deleteCase, deleteCoverageRow, generateCases, importPastedCases, saveCoverageRow, updateCaseFlags, updateStoryIntake } from "../actions";

export const dynamic = "force-dynamic";

export default async function StoryPage({ params, searchParams }: { params: Promise<{ id: string; sid: string }>; searchParams: Promise<{ ok?: string; err?: string; info?: string }> }) {
  const { id, sid } = await params; const sp = await searchParams;
  const story = await prisma.story.findUnique({ where: { id: sid }, include: { testCases: { orderBy: { tcId: "asc" } }, coverage: true, release: true, testData: { orderBy: [{ field: "asc" }, { kind: "asc" }] } } });
  if (!story || story.releaseId !== id) notFound();
  const running = await runningJob(id);
  const [job, docCount] = await Promise.all([
    prisma.generationJob.findFirst({ where: { releaseId: id, kind: "testcases", OR: [{ storyRefId: sid }, { storyRefId: null }] }, orderBy: { startedAt: "desc" } }),
    prisma.document.count({ where: { releaseId: id } }),
  ]);
  const unreviewed = story.testCases.filter((t) => !t.reviewed).length;
  const gaps = coverageGaps(story.acceptanceCriteria, story.coverage, story.testCases);
  const acs = parseCriteria(story.acceptanceCriteria);

  return (
    <>
      <h1>{story.storyId}: {story.title}</h1>
      <p className="muted">{story.release.name} · {story.module} · <Link href={`/releases/${id}/stories`}>all stories</Link></p>
      <ReleaseNav releaseId={id} active="stories" />
      <Notice searchParams={sp} />
      <JobLoader job={job} />

      <div className="grid-2">
        <div className="card">
          <h3>User story</h3>
          <p className="muted">Filled from your <Link href={`/releases/${id}/documents`}>user stories file</Link> when this story is first generated; edit anything here. The clarification log is what goes to the PM.</p>
          <form action={updateStoryIntake} className="stack">
            <input type="hidden" name="id" value={story.id} /><input type="hidden" name="releaseId" value={id} />
            <div className="fields">
              <label><span className="req">Title</span><input name="title" defaultValue={story.title} required /></label>
              <label><span className="req">Module</span><input name="module" defaultValue={story.module} required /></label>
            </div>
            <label><span>User story</span><textarea name="userStory" defaultValue={story.userStory} placeholder="As a ... I want ... so that ..." /></label>
            <label><span className="req">Acceptance criteria</span><textarea name="acceptanceCriteria" defaultValue={story.acceptanceCriteria} placeholder="One criterion per line" /></label>
            <label><span>Field document (all fields, types, validations, defaults, dropdown values)</span><textarea name="fieldDoc" defaultValue={story.fieldDoc} style={{ minHeight: "9rem" }} placeholder="Field | Type | Mandatory | Min/Max | Format | Default | Values" /></label>
            <label><span>Prototype notes (screens, states, navigation)</span><textarea name="prototypeNotes" defaultValue={story.prototypeNotes} /></label>
            <label><span>Clarification log (open questions, assumptions, out of scope, prototype mismatches)</span><textarea name="clarificationLog" defaultValue={story.clarificationLog} /></label>
            <div><button type="submit">Save</button></div>
          </form>
        </div>

        <div className="card">
          <h3>Stage 2: Test design</h3>
          <p className="muted">Reads this story's module documents ({docCount} uploaded in this release) and the intake on the left, then adds cases until nothing below is uncovered. Existing cases are kept. Anything ambiguous lands in the clarification log. New cases arrive unreviewed and unapproved.</p>
          <EnginePicker flow="testcases" back={`/releases/${id}/stories/${sid}`} />
          <form action={generateCases} style={{ marginBottom: "1rem" }}>
            <input type="hidden" name="id" value={story.id} /><input type="hidden" name="releaseId" value={id} />
            <button type="submit" disabled={!!running}>Generate this story</button>
          </form>
          <details>
            <summary>Paste cases from ChatGPT (pipe table)</summary>
            <form action={importPastedCases} className="stack" style={{ marginTop: ".5rem" }}>
              <input type="hidden" name="id" value={story.id} /><input type="hidden" name="releaseId" value={id} />
              <textarea name="pasted" style={{ minHeight: "8rem" }} placeholder={"| TC ID | Story ID | Module | Title | Type | Priority | Pre-condition | Steps | Test data | Expected result |\n| --- | ... |"} />
              <div><button type="submit" className="secondary">Import pasted rows</button></div>
            </form>
          </details>
          <details style={{ marginTop: ".75rem" }}>
            <summary>Add one case by hand</summary>
            <form action={addCase} className="stack" style={{ marginTop: ".5rem" }}>
              <input type="hidden" name="id" value={story.id} /><input type="hidden" name="releaseId" value={id} />
              <div className="fields">
                <label><span>TC ID</span><input name="tcId" placeholder="Blank: the story's next number" /></label>
                <label><span>Module</span><input name="module" defaultValue={story.module} /></label>
                <label><span>Type</span><select name="type" defaultValue="Positive">{["Positive", "Negative", "Boundary", "Validation", "Navigation"].map((t) => <option key={t}>{t}</option>)}</select></label>
                <label><span>Priority</span><select name="priority" defaultValue="P2">{["P1", "P2", "P3"].map((t) => <option key={t}>{t}</option>)}</select></label>
                <label className="full"><span className="req">Title</span><input name="title" required /></label>
                <label className="full"><span>Pre-condition</span><input name="precondition" /></label>
                <label className="full"><span>Steps (one per line)</span><textarea name="steps" /></label>
                <label><span>Test data</span><input name="testData" /></label>
                <label><span>Expected result</span><input name="expected" /></label>
                <label><span>Criteria covered, e.g. AC1,AC3</span><input name="criteria" /></label>
              </div>
              <div><button type="submit" className="secondary">Save case</button></div>
            </form>
          </details>
        </div>
      </div>

      <h2>Test cases ({story.testCases.length}) <span className="muted" style={{ fontWeight: 400 }}>{unreviewed} unreviewed</span></h2>
      <div className="card">
        <form action={bulkCaseAction}>
          <input type="hidden" name="releaseId" value={id} /><input type="hidden" name="storyId" value={story.id} />
          <div className="row" style={{ marginBottom: ".6rem" }}>
            <span className="muted">Selected:</span>
            <button className="small secondary" name="action" value="review">Mark reviewed</button>
            <button className="small secondary" name="action" value="smoke">Flag smoke</button>
            <button className="small secondary" name="action" value="regression">Flag regression</button>
            <ConfirmButton className="small danger" name="action" value="delete" message="Delete the ticked test cases? This cannot be undone.">Delete</ConfirmButton>
          </div>
          <div className="tbox">
            <table>
              <thead><tr><th></th><th>TC ID</th><th>Title</th><th>Type</th><th>Pri</th><th>Steps</th><th>Expected</th><th>Src</th><th>Rev</th><th>Smoke</th><th>Reg</th><th>Auto</th></tr></thead>
              <tbody>
                {story.testCases.map((t) => (
                  <tr key={t.id}>
                    <td><input type="checkbox" name="caseId" value={t.id} /></td>
                    <td className="mono">{t.tcId}</td>
                    <td>{t.title}{t.precondition && <div className="muted">Pre: {t.precondition}</div>}{t.testData && <div className="muted">Data: {t.testData}</div>}{t.criteria && <div className="muted">Covers: {t.criteria}</div>}{t.sourceRef && <div className="muted">From: {t.sourceRef}</div>}</td>
                    <td>{t.type}</td>
                    <td><Badge tone={t.priority === "P1" ? "bad" : t.priority === "P2" ? "warn" : undefined}>{t.priority}</Badge></td>
                    <td><pre>{t.steps}</pre></td>
                    <td>{t.expected}</td>
                    <td className="muted">{t.source}</td>
                    <td>{t.reviewed ? "✓" : ""}</td><td>{t.smoke ? "✓" : ""}</td><td>{t.regression ? "✓" : ""}</td><td>{t.automated ? "✓" : ""}</td>
                  </tr>
                ))}
                {!story.testCases.length && <tr><td colSpan={12} className="muted">No test cases yet. Generate, paste or add one.</td></tr>}
              </tbody>
            </table>
          </div>
        </form>
        {story.testCases.length > 0 && (
          <details style={{ marginTop: ".75rem" }}>
            <summary>Edit flags per case</summary>
            <div className="tbox" style={{ marginTop: ".5rem" }}>
              <table>
                <thead><tr><th>TC ID</th><th>Priority</th><th>Reviewed</th><th>Smoke</th><th>Regression</th><th>Automated</th><th></th><th></th></tr></thead>
                <tbody>
                  {story.testCases.map((t) => (
                    <tr key={t.id}>
                      <td className="mono">{t.tcId}</td>
                      <td colSpan={6}>
                        <form action={updateCaseFlags} className="row">
                          <input type="hidden" name="id" value={t.id} /><input type="hidden" name="releaseId" value={id} /><input type="hidden" name="storyId" value={story.id} />
                          <select name="priority" defaultValue={t.priority} style={{ width: "auto" }}>{["P1", "P2", "P3"].map((p) => <option key={p}>{p}</option>)}</select>
                          <input name="criteria" defaultValue={t.criteria} placeholder="AC1,AC3" style={{ maxWidth: 110 }} />
                          <label className="inline"><input type="checkbox" name="reviewed" defaultChecked={t.reviewed} /> reviewed</label>
                          <label className="inline"><input type="checkbox" name="smoke" defaultChecked={t.smoke} /> smoke</label>
                          <label className="inline"><input type="checkbox" name="regression" defaultChecked={t.regression} /> regression</label>
                          <label className="inline"><input type="checkbox" name="automated" defaultChecked={t.automated} /> automated</label>
                          <button className="small secondary" type="submit">Save</button>
                        </form>
                      </td>
                      <td><form action={deleteCase} className="inline-form"><input type="hidden" name="id" value={t.id} /><input type="hidden" name="releaseId" value={id} /><input type="hidden" name="storyId" value={story.id} /><button className="small secondary">Delete</button></form></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </div>

      <h2>Test data ({story.testData.length})</h2>
      <div className="card" style={{ marginBottom: "1rem" }}>
        <div className="tbox" style={{ maxHeight: "24rem" }}>
          <table>
            <thead><tr><th>Field</th><th>Kind</th><th>Value</th><th>Why</th><th>Used by</th></tr></thead>
            <tbody>
              {story.testData.map((r) => (
                <tr key={r.id}><td>{r.field}</td><td><Badge tone={r.kind === "Valid" ? "ok" : r.kind === "Invalid" ? "bad" : r.kind === "Boundary" ? "warn" : undefined}>{r.kind}</Badge></td><td className="mono" style={{ overflowWrap: "anywhere" }}>{r.value || <span className="muted">(empty)</span>}</td><td className="muted">{r.purpose}</td><td className="mono muted">{r.tcIds}</td></tr>
              ))}
              {!story.testData.length && <tr><td colSpan={5} className="muted">Generate this story to create its test data.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <h2>Coverage gaps <Badge tone={gaps.length ? "warn" : "ok"}>{gaps.length ? `${gaps.length} uncovered` : "All covered"}</Badge></h2>
      <div className="card" style={{ marginBottom: "1rem" }}>
        <p className="muted">Computed by the server from the acceptance criteria and coverage matrix. Gate 2 stays open while anything is listed. This proves every requirement has a tagged case; whether each case is correct is still your review.</p>
        {gaps.length > 0 && <ul>{gaps.map((g) => <li key={g.key}>{g.label}</li>)}</ul>}
        {acs.length > 0 && <details><summary>Acceptance criteria numbering</summary><ul>{acs.map((c) => <li key={c.id}>{c.id}: {c.text}</li>)}</ul></details>}
      </div>

      <h2>Coverage matrix ({story.coverage.length} fields)</h2>
      <div className="card">
        <p className="muted">One row per field in the field document. Every row must list the TC IDs that cover it; a row without TC IDs is a gap.</p>
        <div className="tbox">
          <table>
            <thead><tr><th>Field</th><th>Mandatory</th><th>Min/Max</th><th>Format</th><th>Default</th><th>Dropdown values</th><th>TC IDs</th><th></th></tr></thead>
            <tbody>
              {story.coverage.map((r) => (
                <tr key={r.id} style={!r.tcIds.trim() ? { background: "var(--bad-soft)" } : undefined}>
                  <td>{r.field}</td><td>{r.mandatory}</td><td>{r.minMax}</td><td>{r.format}</td><td>{r.defaultV}</td><td>{r.dropdown}</td><td className="mono">{r.tcIds || "GAP"}</td>
                  <td><form action={deleteCoverageRow} className="inline-form"><input type="hidden" name="id" value={r.id} /><input type="hidden" name="storyId" value={story.id} /><input type="hidden" name="releaseId" value={id} /><button className="small secondary">Remove</button></form></td>
                </tr>
              ))}
              <tr>
                <td colSpan={8}>
                  <form action={saveCoverageRow} className="row">
                    <input type="hidden" name="storyId" value={story.id} /><input type="hidden" name="releaseId" value={id} />
                    <input name="field" placeholder="Field" style={{ maxWidth: 140 }} required /><input name="mandatory" placeholder="Mandatory" style={{ maxWidth: 100 }} /><input name="minMax" placeholder="Min/Max" style={{ maxWidth: 100 }} /><input name="format" placeholder="Format" style={{ maxWidth: 120 }} /><input name="defaultV" placeholder="Default" style={{ maxWidth: 100 }} /><input name="dropdown" placeholder="Values" style={{ maxWidth: 160 }} /><input name="tcIds" placeholder="TC IDs" style={{ maxWidth: 200 }} />
                    <button className="small secondary" type="submit">Add row</button>
                  </form>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
