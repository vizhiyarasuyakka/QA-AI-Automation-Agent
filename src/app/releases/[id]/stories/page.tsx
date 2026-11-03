import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ReleaseNav } from "@/components/ReleaseNav";
import { Notice } from "@/components/Notice";
import { Badge } from "@/components/Badge";
import { EnginePicker } from "@/components/EnginePicker";
import { JobLoader } from "@/components/JobLoader";
import { StoryPicker } from "@/components/StoryPicker";
import { filesChangedSinceRead, flowStates } from "@/lib/flows";
import { latestJob, runningJob } from "@/lib/jobs";
import { casePrompt, DEFAULT_CASE_PROMPT } from "@/lib/prompts";
import { addCase, createStory, deleteStories, triggerGeneration, triggerStoryReading, updateCasePrompt } from "./actions";

export const dynamic = "force-dynamic";

export default async function StoriesPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; err?: string; info?: string }> }) {
  const { id } = await params; const sp = await searchParams;
  const release = await prisma.release.findUnique({ where: { id } });
  if (!release) notFound();
  const running = await runningJob(id);
  const [stories, job, readJob, filesChanged, states, storyFiles, prds, dataCounts, prompt] = await Promise.all([
    prisma.story.findMany({ where: { releaseId: id }, orderBy: [{ module: "asc" }, { storyId: "asc" }], include: { testCases: { orderBy: { tcId: "asc" } }, coverage: true } }),
    latestJob(id, "testcases"),
    latestJob(id, "prd"),
    filesChangedSinceRead(id),
    flowStates(id),
    prisma.document.count({ where: { releaseId: id, status: "Ready", docType: "User stories" } }),
    prisma.document.findMany({ where: { releaseId: id, status: "Ready", docType: "PRD" }, orderBy: { fileName: "asc" }, select: { id: true, fileName: true, module: true, text: true } }),
    prisma.testDataRow.groupBy({ by: ["storyId"], where: { story: { releaseId: id } }, _count: true }),
    casePrompt(),
  ]);
  const dataBy = new Map(dataCounts.map((d) => [d.storyId, d._count]));
  const total = stories.reduce((a, s) => a + s.testCases.length, 0);
  const back = `/releases/${id}/stories`;
  const withCases = stories.filter((s) => s.testCases.length);

  return (
    <>
      <h1>{release.name}: test cases</h1>
      <p className="muted">Step 2. Select your user stories file, or stories inside it, and generate the test cases and test data. A PRD is optional. Export and review come next in step 3.</p>
      <ReleaseNav releaseId={id} active="stories" />
      <Notice searchParams={sp} />

      <div className="card" style={{ marginBottom: "1rem" }}>
        <div className="row spread"><strong>Test case flow status</strong><Badge tone={states.testcases.tone}>{states.testcases.status}</Badge></div>
        <p className="muted" style={{ margin: ".4rem 0 .6rem" }}>{states.testcases.detail}</p>
        <EnginePicker flow="testcases" back={back} />
      </div>

      <div className="card" style={{ marginBottom: "1rem" }}>
        <div className="row spread"><h3 style={{ margin: 0 }}>Test case prompt</h3><Badge tone={prompt === DEFAULT_CASE_PROMPT ? undefined : "accent"}>{prompt === DEFAULT_CASE_PROMPT ? "Default" : "Edited"}</Badge></div>
        <p className="muted" style={{ margin: ".4rem 0 .6rem" }}>Claude follows this when it writes test cases and test data. It applies to the next generation in every release; cases already written stay as they are. The app always adds its own rules: uploaded files are data, steps are numbered, and cases are tagged with what they cover.</p>
        <form action={updateCasePrompt} className="stack">
          <input type="hidden" name="releaseId" value={id} />
          <textarea key={prompt} name="prompt" defaultValue={prompt} aria-label="Test case prompt" style={{ minHeight: "11rem" }} />
          <div className="row">
            <button type="submit" className="secondary">Save prompt</button>
            <button type="submit" className="secondary" name="reset" value="1" disabled={prompt === DEFAULT_CASE_PROMPT}>Reset to default</button>
          </div>
        </form>
      </div>

      <div className="card" style={{ marginBottom: "1rem" }}>
        <h3>Generate test cases and test data</h3>
        <form action={triggerStoryReading} className="row" style={{ marginBottom: ".75rem" }}>
          <input type="hidden" name="releaseId" value={id} />
          <button type="submit" className={stories.length && !filesChanged ? "small secondary" : undefined} disabled={!storyFiles || !!running}>{stories.length ? "Load user stories again" : "Load user stories"}</button>
          <span className="muted">
            {!storyFiles
              ? <>Add your user stories file in <Link href={`/releases/${id}/documents`}>step 1</Link> first.</>
              : running ? "Another run is in progress."
              : filesChanged ? "A user stories file changed after the stories were loaded. Load them again to pick up new ones."
              : "Lists the stories in your user stories file. A PRD is never used for this."}
          </span>
        </form>
        <form action={triggerGeneration}>
          <input type="hidden" name="releaseId" value={id} />
          <StoryPicker
            releaseId={id}
            started={sp.info === "Generation started"}
            stories={stories.map((s) => ({ id: s.id, storyId: s.storyId, title: s.title, sourceFile: s.sourceFile, cases: s.testCases.length }))}
            prds={prds.map((p) => ({ id: p.id, fileName: p.fileName, module: p.module, chars: p.text.length }))}
            deleteAction={deleteStories}
            disabled={!!running}
            disabledNote={running ? "Another run is in progress." : undefined}
          />
        </form>
        <details style={{ marginTop: ".75rem" }}>
          <summary>Add a story by hand</summary>
          <form action={createStory} className="row" style={{ marginTop: ".5rem" }}>
            <input type="hidden" name="releaseId" value={id} />
            <input name="storyId" placeholder="Story ID, e.g. VR-203" aria-label="Story ID" style={{ maxWidth: 160 }} required />
            <input name="module" placeholder="Module, e.g. Payments" aria-label="Module" style={{ maxWidth: 200 }} required />
            <input name="title" placeholder="Story title" aria-label="Story title" style={{ maxWidth: 420 }} required />
            <button type="submit" className="secondary">Add story</button>
          </form>
        </details>
      </div>

      <div className="card" style={{ marginBottom: "1rem" }}>
        <details>
          <summary><strong>Add a test case by hand</strong> <span className="muted">for any user story; leave the TC ID blank for the next number</span></summary>
          {!stories.length ? <p className="muted" style={{ margin: ".5rem 0 0" }}>Load or add a user story first.</p> : (
            <form action={addCase} className="stack" style={{ marginTop: ".6rem" }}>
              <input type="hidden" name="releaseId" value={id} /><input type="hidden" name="back" value={back} />
              <div className="fields">
                <label className="full"><span className="req">User story</span>
                  <select name="id" defaultValue="" required aria-label="User story">
                    <option value="" disabled>Choose a user story</option>
                    {[...new Set(stories.map((s) => s.module))].map((m) => <optgroup key={m} label={m}>{stories.filter((s) => s.module === m).map((s) => <option key={s.id} value={s.id}>{s.storyId} {s.title.slice(0, 70)}</option>)}</optgroup>)}
                  </select>
                </label>
                <label className="full"><span className="req">Title</span><input name="title" required placeholder="Register a Client BOQ with the required header fields" /></label>
                <label><span>Type</span><select name="type" defaultValue="Positive">{["Positive", "Negative", "Boundary", "Validation", "Navigation"].map((t) => <option key={t}>{t}</option>)}</select></label>
                <label><span>Priority</span><select name="priority" defaultValue="P2">{["P1", "P2", "P3"].map((t) => <option key={t}>{t}</option>)}</select></label>
                <label><span>Acceptance criteria it covers</span><input name="criteria" placeholder="AC1, AC3" /></label>
                <label><span>TC ID</span><input name="tcId" placeholder="Blank: the story's next number" /></label>
                <label className="full"><span>Pre-condition</span><input name="precondition" /></label>
                <label className="full"><span>Steps (one per line)</span><textarea name="steps" /></label>
                <label className="full"><span>Test data</span><input name="testData" placeholder="Email: qa.user@example.com" /></label>
                <label className="full"><span>Expected result</span><input name="expected" /></label>
              </div>
              <div><button type="submit" className="secondary">Add test case</button></div>
            </form>
          )}
        </details>
      </div>

      <JobLoader job={readJob} />
      <JobLoader job={job} />

      <h2>Test cases created ({total}) <span className="muted" style={{ fontWeight: 400 }}>for {withCases.length} of {stories.length} stories</span></h2>
      {!withCases.length && <div className="card muted">None yet. Select user stories above and generate.</div>}
      {withCases.map((s) => (
        <details key={s.id} className="card" style={{ marginBottom: ".5rem" }} open={withCases.length <= 3}>
          <summary><strong>{s.storyId}</strong> {s.title} <span className="muted">{s.module}, {s.testCases.length} cases, {dataBy.get(s.id) ?? 0} test data rows</span></summary>
          <div className="tbox" style={{ marginTop: ".5rem" }}>
            <table>
              <thead><tr><th>TC ID</th><th>Case</th><th>Type</th><th>Priority</th><th>Covers</th><th>Expected</th></tr></thead>
              <tbody>
                {s.testCases.map((t) => (
                  <tr key={t.id}>
                    <td className="mono">{t.tcId}</td>
                    <td style={{ minWidth: 200 }}>{t.title}</td>
                    <td>{t.type}</td>
                    <td><Badge tone={t.priority === "P1" ? "bad" : t.priority === "P2" ? "warn" : undefined}>{t.priority}</Badge></td>
                    <td className="muted">{t.criteria || "-"}</td>
                    <td style={{ minWidth: 200 }}>{t.expected}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ margin: ".5rem 0 0" }}><Link href={`/releases/${id}/stories/${s.id}`}>Open this story</Link></p>
        </details>
      ))}
    </>
  );
}
