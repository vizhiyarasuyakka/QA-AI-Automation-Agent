import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ReleaseNav } from "@/components/ReleaseNav";
import { Notice } from "@/components/Notice";
import { Badge } from "@/components/Badge";
import { ConfirmButton } from "@/components/ConfirmButton";
import { SelectGroup } from "@/components/SelectGroup";
import { coverageGaps, parseCriteria } from "@/lib/coverage";
import { CASE_FIELDS, FIELD_LABELS, type TemplateColumn } from "@/lib/export";
import { flowStates } from "@/lib/flows";
import { bulkCaseAction, deleteTemplate, saveTemplateColumns, uploadTemplate } from "../stories/actions";

export const dynamic = "force-dynamic";

export default async function ReviewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; err?: string; info?: string; story?: string; module?: string }> }) {
  const { id } = await params; const sp = await searchParams;
  const release = await prisma.release.findUnique({ where: { id } });
  if (!release) notFound();
  const [states, templates, stories] = await Promise.all([
    flowStates(id),
    prisma.exportTemplate.findMany({ orderBy: { createdAt: "desc" }, select: { id: true, name: true, fileName: true, columns: true } }),
    prisma.story.findMany({ where: { releaseId: id }, orderBy: [{ module: "asc" }, { storyId: "asc" }], include: { testCases: { orderBy: { tcId: "asc" } }, coverage: true, _count: { select: { testData: true } } } }),
  ]);
  const withCases = stories.filter((s) => s.testCases.length);
  const totalCases = stories.reduce((a, s) => a + s.testCases.length, 0);
  const totalData = stories.reduce((a, s) => a + s._count.testData, 0);
  const moduleView = withCases.some((s) => s.module === sp.module) ? sp.module : undefined;
  const story = moduleView ? undefined : withCases.find((s) => s.id === sp.story) ?? withCases.find((s) => s.testCases.some((t) => !t.reviewed)) ?? withCases[0];
  const modules = [...new Set(withCases.map((s) => s.module))];
  const gaps = story ? coverageGaps(story.acceptanceCriteria, story.coverage, story.testCases) : [];
  const shownStories = moduleView ? withCases.filter((s) => s.module === moduleView) : story ? [story] : [];
  const shown = shownStories.flatMap((s) => s.testCases.map((t) => ({ ...t, storyCode: s.storyId })));
  const unreviewed = shown.filter((t) => !t.reviewed).length;
  const dataRows = shownStories.reduce((a, s) => a + s._count.testData, 0);
  const group = moduleView ?? story?.id ?? "";
  const back = moduleView ? `/releases/${id}/review?module=${encodeURIComponent(moduleView)}` : story ? `/releases/${id}/review?story=${story.id}` : `/releases/${id}/review`;

  return (
    <>
      <h1>{release.name}: test case review</h1>
      <p className="muted">Step 3. Tick the test cases, then export them to review outside the app or mark them reviewed here. Every case goes to test execution; nothing needs approving.</p>
      <ReleaseNav releaseId={id} active="review" />
      <Notice searchParams={sp} />

      <div className="card" style={{ marginBottom: "1rem" }}>
        <div className="row spread"><strong>Review status</strong><Badge tone={states.review.tone}>{states.review.status}</Badge></div>
        <p className="muted" style={{ margin: ".4rem 0 0" }}>{states.review.detail}</p>
      </div>

      {!withCases.length ? (
        <div className="card muted">Nothing to review yet. <Link href={`/releases/${id}/stories`}>Generate test cases</Link> first.</div>
      ) : (
        <div className="split">
          <nav className="card split-list" aria-label="Stories to review">
            {modules.map((m) => (
              <div key={m} className="split-group">
                <strong>{m}</strong>
                <Link href={`/releases/${id}/review?module=${encodeURIComponent(m)}`} className={`split-item ${m === moduleView ? "active" : ""}`} aria-current={m === moduleView ? "page" : undefined}>
                  <span className="split-title">All cases in this module</span>
                  <span className="muted split-meta">{withCases.filter((s) => s.module === m).reduce((a, s) => a + s.testCases.length, 0)} cases</span>
                </Link>
                {withCases.filter((s) => s.module === m).map((s) => {
                  const done = s.testCases.filter((t) => t.reviewed).length;
                  return (
                    <Link key={s.id} href={`/releases/${id}/review?story=${s.id}`} className={`split-item ${s.id === story?.id ? "active" : ""}`} aria-current={s.id === story?.id ? "page" : undefined}>
                      <span className="split-title">{s.storyId} {s.title}</span>
                      <span className="muted split-meta">{done} of {s.testCases.length} reviewed</span>
                    </Link>
                  );
                })}
              </div>
            ))}
          </nav>

          {(story || moduleView) && (
            <div style={{ minWidth: 0 }}>
              {story && <div className="card" style={{ marginBottom: ".75rem" }}>
                <div className="row spread">
                  <h3 style={{ margin: 0 }}>{story.storyId}: {story.title}</h3>
                  <Link href={`/releases/${id}/stories/${story.id}`}>Edit this story</Link>
                </div>
                <p className="muted" style={{ margin: ".35rem 0 .6rem" }}>{story.module}{story.userStory ? `. ${story.userStory}` : ""}</p>
                <table>
                  <thead><tr><th>Acceptance criterion</th><th className="num">Cases</th></tr></thead>
                  <tbody>
                    {parseCriteria(story.acceptanceCriteria).map((c) => (
                      <tr key={c.id}><td><strong>{c.id}</strong> {c.text}</td><td className="num">{story.testCases.filter((t) => t.criteria.toUpperCase().split(/[,\s]+/).includes(c.id)).length}</td></tr>
                    ))}
                  </tbody>
                </table>
                {gaps.length > 0 && (
                  <div className="notice warn" style={{ margin: ".75rem 0 0" }}>
                    {gaps.length} {gaps.length === 1 ? "requirement has" : "requirements have"} no covering case: {gaps.slice(0, 4).map((g) => g.label).join("; ")}{gaps.length > 4 ? ` and ${gaps.length - 4} more` : ""}. <Link href={`/releases/${id}/stories`}>Generate this story again</Link> or <Link href={`/releases/${id}/stories/${story.id}`}>add a case</Link>.
                  </div>
                )}
              </div>}

              <form action={bulkCaseAction} className="card" style={{ marginBottom: ".75rem" }}>
                <input type="hidden" name="releaseId" value={id} /><input type="hidden" name="storyId" value={story?.id ?? ""} /><input type="hidden" name="back" value={back} />
                <strong style={{ display: "block", marginBottom: ".6rem" }}>{moduleView ? `${moduleView}: ` : ""}Test cases ({shown.length}) <span className="muted" style={{ fontWeight: 400 }}>{unreviewed} to review, {dataRows} test data rows</span></strong>
                <div className="row" style={{ marginBottom: ".5rem" }}>
                  <span className="muted">Export the ticked cases:</span>
                  <select name="format" defaultValue="xlsx" aria-label="Export format" style={{ width: "auto", maxWidth: 240 }}>
                    <option value="xlsx">Excel (.xlsx)</option>
                    <option value="csv">CSV</option>
                    {templates.map((t) => <option key={t.id} value={`template:${t.id}`}>Template: {t.name}</option>)}
                  </select>
                  <button type="submit" className="small secondary" formAction={`/releases/${id}/stories/export`} formMethod="post">Export</button>
                </div>
                <div className="row" style={{ marginBottom: ".6rem" }}>
                  <span className="muted">Review the ticked cases by hand:</span>
                  <div className="row">
                    <button className="small" name="action" value="review">Mark reviewed</button>
                    <button className="small secondary" name="action" value="smoke">Flag smoke</button>
                    <button className="small secondary" name="action" value="regression">Flag regression</button>
                    <ConfirmButton className="small danger" name="action" value="delete" message="Delete the ticked test cases? This cannot be undone.">Delete</ConfirmButton>
                  </div>
                </div>
                <div className="tbox">
                  <table>
                    <thead><tr><th><SelectGroup field="caseId" group={group} label="Select all these cases" /></th>{moduleView && <th>Story</th>}<th>TC ID</th><th>Case</th><th>Steps</th><th>Expected</th><th>Covers</th><th>Status</th></tr></thead>
                    <tbody>
                      {shown.map((t) => (
                        <tr key={t.id}>
                          <td><input type="checkbox" name="caseId" value={t.id} data-group={group} aria-label={`Select ${t.tcId}`} /></td>
                          {moduleView && <td><Link href={`/releases/${id}/review?story=${t.storyId}`}>{t.storyCode}</Link></td>}
                          <td className="mono">{t.tcId}</td>
                          <td style={{ minWidth: 200 }}>{t.title}<div className="muted">{t.type}, {t.priority}{t.smoke ? ", smoke" : ""}{t.regression ? ", regression" : ""}</div>{t.precondition && <div className="muted">Pre: {t.precondition}</div>}{t.testData && <div className="muted" style={{ whiteSpace: "pre-wrap" }}>Data: {t.testData}</div>}</td>
                          <td style={{ minWidth: 200 }}><pre>{t.steps}</pre></td>
                          <td style={{ minWidth: 160 }}>{t.expected}</td>
                          <td className="muted">{t.criteria || "-"}</td>
                          <td><Badge tone={t.reviewed ? "ok" : "warn"}>{t.reviewed ? "Reviewed" : "To review"}</Badge></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </form>

            </div>
          )}
        </div>
      )}

      <h2 style={{ marginTop: "1.25rem" }}>Export the whole release</h2>
      <div className="grid-2" style={{ marginBottom: "1rem" }}>
        <div className="card">
          <h3>Export test data</h3>
          <p className="muted">{totalData} rows: exact values for each field, with the cases that use them.</p>
          <form action={`/releases/${id}/stories/export`} method="get" className="row">
            <select name="format" defaultValue="data-xlsx" aria-label="Test data format" style={{ width: "auto" }}><option value="data-xlsx">Excel (.xlsx)</option><option value="data-csv">CSV</option></select>
            <button type="submit" className="secondary" disabled={!totalData}>Download test data</button>
          </form>
        </div>
        <div className="card">
          <h3>Export test cases</h3>
          <form action={`/releases/${id}/stories/export`} method="get" className="stack">
            <div className="row">
              <select name="format" defaultValue="xlsx" aria-label="Test case format" style={{ width: "auto", maxWidth: 320 }}>
                <option value="xlsx">Excel (.xlsx)</option>
                <option value="csv">CSV</option>
                {templates.map((t) => <option key={t.id} value={`template:${t.id}`}>Template: {t.name}</option>)}
              </select>
                            <button type="submit" className="secondary" disabled={!totalCases}>Download test cases</button>
            </div>
          </form>
          <details style={{ marginTop: ".75rem" }}>
            <summary>Upload a template</summary>
            <form action={uploadTemplate} className="stack" style={{ marginTop: ".5rem" }}>
              <input type="hidden" name="releaseId" value={id} />
              <input type="file" name="file" accept=".xlsx,.csv" required />
              <input name="name" placeholder="Template name (optional)" />
              <div><button type="submit" className="secondary">Upload template</button> <span className="muted">Cases are written under its header row. Excel styling is kept.</span></div>
            </form>
          </details>
          {templates.map((t) => {
            const columns = JSON.parse(t.columns) as TemplateColumn[];
            return (
              <details key={t.id} style={{ marginTop: ".5rem" }}>
                <summary>{t.name} <span className="muted">{t.fileName}, {columns.filter((c) => !c.field).length} columns left blank</span></summary>
                <form action={saveTemplateColumns} className="stack" style={{ marginTop: ".5rem" }}>
                  <input type="hidden" name="id" value={t.id} /><input type="hidden" name="releaseId" value={id} />
                  <table><thead><tr><th>Template column</th><th>Fill with</th></tr></thead><tbody>
                    {columns.map((c, i) => (
                      <tr key={i}><td>{c.header || <span className="muted">(no header)</span>}</td>
                        <td><select name={`col${i}`} defaultValue={c.field}><option value="">Leave blank</option>{CASE_FIELDS.map((f) => <option key={f} value={f}>{FIELD_LABELS[f]}</option>)}</select></td></tr>
                    ))}
                  </tbody></table>
                  <div><button className="small secondary" type="submit">Save columns</button></div>
                </form>
                <form action={deleteTemplate} className="inline-form" style={{ marginTop: ".3rem" }}><input type="hidden" name="id" value={t.id} /><input type="hidden" name="releaseId" value={id} /><button className="small secondary">Remove template</button></form>
              </details>
            );
          })}
        </div>
      </div>
    </>
  );
}
