import { prisma } from "@/lib/prisma";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Badge, resultTone } from "@/components/Badge";
import { ConfirmButton } from "@/components/ConfirmButton";
import { JobPanel } from "@/components/JobPanel";
import { PendingButton } from "@/components/PendingButton";
import { boxesOf, KIND_NAMES, type CheckSpec } from "@/lib/storychecks";
import { removeStoryFlow, runStoryChecks, saveStoryFlow, writeStoryChecks } from "./actions";

const matchTone = (r: string) => (r === "Match" ? "ok" : r === "Mismatch" ? "bad" : r === "Blocked" ? "warn" : undefined);
const parse = <T,>(s: string, fallback: T): T => { try { return JSON.parse(s) as T; } catch { return fallback; } };
type Running = { kind: string; phase: string; storiesDone: number; storiesTotal: number; casesAdded: number } | null;

/** What a check asks for, beyond its sentence: the field's kind and mark, the choices, or how the form is tried. */
function detail(kind: string, spec: CheckSpec) {
  if (kind === "field") return [spec.fieldType !== "any" && spec.fieldType, spec.required === "yes" ? "required" : spec.required === "no" ? "optional" : ""].filter(Boolean).join(", ");
  if (kind === "options") return spec.options.length ? `${spec.exact ? "Exactly" : "At least"}: ${spec.options.join(", ")}` : "";
  if (kind === "validation") return `Press ${spec.submit || "save"}${spec.fill.length ? ` after filling ${spec.fill.map((f) => `${f.field} = ${f.value === "*" ? "first choice" : f.value || "(empty)"}`).join("; ")}` : ""}`;
  return "";
}

/**
 * UI testing by user story: each story's acceptance criteria and field rules, written as flows and checks, then
 * checked on the build. Every flow shows its checks with what was found and the evidence pictures.
 */
export async function StoryChecks({ releaseId, focus, running }: { releaseId: string; focus?: string; running: Running }) {
  const [stories, build, job, flowShots, checkShots] = await Promise.all([
    prisma.story.findMany({
      where: { releaseId }, orderBy: { storyId: "asc" },
      select: {
        id: true, storyId: true, title: true, acceptanceCriteria: true,
        uiFlows: { orderBy: { no: "asc" }, select: { id: true, no: true, name: true, page: true, screen: true, steps: true, result: true, summary: true, buildNo: true, runAt: true, checks: { orderBy: { no: "asc" }, select: { id: true, no: true, kind: true, target: true, expect: true, spec: true, criteria: true, result: true, actual: true, box: true } } } },
      },
    }),
    prisma.build.findFirst({ where: { releaseId }, orderBy: { deployedAt: "desc" }, select: { envUrl: true, appMap: true, appMapAt: true } }),
    prisma.generationJob.findFirst({ where: { releaseId, kind: { in: ["story-checks", "story-run"] } }, orderBy: { startedAt: "desc" } }),
    prisma.storyFlow.findMany({ where: { releaseId, NOT: { shot: null } }, select: { id: true } }),
    prisma.storyCheck.findMany({ where: { releaseId, NOT: { shot: null } }, select: { id: true } }),
  ]);
  const withShot = new Set(flowShots.map((f) => f.id)), checkWithShot = new Set(checkShots.map((c) => c.id));
  const flows = stories.flatMap((s) => s.uiFlows);
  const checks = flows.flatMap((f) => f.checks);
  const mapped = parse<unknown[]>(build?.appMap ?? "", []).length;
  const mine = running && (running.kind === "story-checks" || running.kind === "story-run") ? running : null;
  const busy = !!running;
  const without = stories.filter((s) => s.acceptanceCriteria.trim() && !s.uiFlows.length).length;
  const open = flows.filter((f) => f.result !== "Match").length;
  const tally = (r: string) => flows.filter((f) => f.result === r).length;
  const passed = checks.filter((c) => c.result === "Pass").length, failed = checks.filter((c) => c.result === "Fail").length;
  const base = `/releases/${releaseId}/ui-testing`;

  return (
    <div className="card" id="stories" style={{ marginTop: "1rem" }}>
      <div className="row spread">
        <h3 style={{ margin: 0 }}>Does the build do what the user stories say?</h3>
        {flows.length > 0 && <span className="row" style={{ gap: ".3rem" }}>{tally("Mismatch") > 0 && <Badge tone="bad">{tally("Mismatch")} differ</Badge>}{tally("Match") > 0 && <Badge tone="ok">{tally("Match")} match</Badge>}<Badge>{flows.length} flows, {checks.length} checks</Badge></span>}
      </div>
      <p className="muted" style={{ margin: ".4rem 0 .75rem" }}>
        The prototype shows how a screen looks; the stories say what it must do. Each story&apos;s acceptance criteria and field rules become flows (a page and the clicks that open a form, a filter or a detail view on it) and checks: every field the story names with its kind and required mark, the choices of its dropdowns and filters, the buttons and texts it mentions, and the error saving gives without a mandatory value or with one that breaks a rule. Writing the checks uses Claude, after the build is mapped by following its navigation; checking them uses Playwright only. Every check has a picture with the spot boxed, and a flow that differs from its story becomes a bug draft.
      </p>

      {mine ? (
        <div className="card loader" role="status" style={{ marginBottom: ".75rem", alignItems: "flex-start" }}>
          <AutoRefresh />
          <span className="spinner" aria-hidden="true" />
          <div style={{ flex: 1 }}>
            <strong>{mine.kind === "story-checks" ? "Writing the user-story checks" : "Checking the user stories on the build"}</strong>
            <div className="muted" style={{ margin: ".3rem 0", overflowWrap: "anywhere" }}>{mine.phase}</div>
            {mine.storiesTotal > 0 && <div className="bar" aria-hidden="true"><span style={{ width: `${Math.round((mine.storiesDone / mine.storiesTotal) * 100)}%`, background: "var(--ok)" }} /></div>}
            <div className="muted" style={{ fontSize: 12 }}>
              {mine.kind === "story-checks" ? `${mine.storiesDone} of ${mine.storiesTotal} stories done, ${mine.casesAdded} checks so far.` : `${mine.storiesDone} of ${mine.storiesTotal} flows checked.`} Each result shows below as soon as it is saved. You can leave this page; it keeps running.
            </div>
          </div>
        </div>
      ) : <JobPanel job={job} />}

      {!build?.envUrl ? (
        <p className="muted">Enter the URL to test above first: the checks are written from what the build shows.</p>
      ) : (
        <div className="grid-2" style={{ marginBottom: ".75rem" }}>
          <form action={writeStoryChecks} className="stack">
            <input type="hidden" name="releaseId" value={releaseId} />
            <strong>1. Write the checks</strong>
            <span className="muted" style={{ fontSize: ".82rem" }}>{mapped ? `The build was mapped on ${build.appMapAt?.toLocaleString("en-IN")}: ${mapped} pages. Map it again after the build changes.` : "The build is mapped first: signed in with the test account above, its navigation followed page by page, up to 40 pages, nothing clicked but links."}</span>
            <select name="scope" defaultValue="missing" aria-label="Stories to write checks for" style={{ width: "auto" }}>
              <option value="missing">Stories without checks ({without})</option>
              <option value="all">All {stories.length} stories again</option>
            </select>
            <label className="inline"><input type="checkbox" name="remap" defaultChecked={!mapped} /> Map the build again first</label>
            <div><PendingButton busy="Starting..." disabled={busy || !stories.length}>Write the checks</PendingButton></div>
          </form>
          <form action={runStoryChecks} className="stack">
            <input type="hidden" name="releaseId" value={releaseId} />
            <strong>2. Check them on the build</strong>
            <select name="scope" defaultValue="all" aria-label="Flows to check" style={{ width: "auto" }}>
              <option value="all">All {flows.length} flows</option>
              <option value="open">Flows not matching ({open})</option>
            </select>
            <label className="inline"><input type="checkbox" name="validation" defaultChecked /> Press Save to check validation errors</label>
            <span className="muted" style={{ fontSize: ".82rem" }}>Each validation check opens the form afresh, leaves one mandatory field empty or puts a wrong value in, and presses the save button the story names, then looks for the error. A build without that check saves the record, so point it at a test environment. Delete, send, approve and the like are never pressed.</span>
            <div><ConfirmButton message={`Check ${flows.length} user-story flows on ${build.envUrl}? With validation checks on, Save is pressed with empty or wrong values; a build without the check would save those records.`} busy="Starting..." disabled={busy || !flows.length}>Check on the build</ConfirmButton></div>
          </form>
        </div>
      )}
      {checks.length > 0 && <p className="muted" style={{ margin: "0 0 .5rem" }}>{passed} checks pass, {failed} fail, {checks.length - passed - failed} blocked or not run.</p>}

      {stories.map((st) => {
        const differ = st.uiFlows.filter((f) => f.result === "Mismatch").length;
        const matched = st.uiFlows.filter((f) => f.result === "Match").length;
        return (
          <details key={st.id} id={`story-${st.id}`} open={focus === st.id || (!focus && differ > 0)} style={{ borderTop: "1px solid var(--line)", padding: ".6rem 0" }}>
            <summary style={{ cursor: "pointer" }}>
              <strong>{st.storyId}</strong> {st.title}{" "}
              {!st.uiFlows.length ? <Badge>No checks yet</Badge> : <>{differ > 0 && <Badge tone="bad">{differ} differ</Badge>} {matched > 0 && <Badge tone="ok">{matched} match</Badge>} <Badge>{st.uiFlows.length} flows</Badge></>}
            </summary>
            <div style={{ marginTop: ".5rem" }}>
              {!st.acceptanceCriteria.trim() ? (
                <p className="muted">No acceptance criteria yet. Fetch them in Test execution, then write its checks.</p>
              ) : (
                <div className="row" style={{ gap: ".4rem", flexWrap: "wrap", marginBottom: ".5rem" }}>
                  <form action={writeStoryChecks} className="inline-form">
                    <input type="hidden" name="releaseId" value={releaseId} /><input type="hidden" name="story" value={st.id} />
                    {st.uiFlows.length ? <ConfirmButton className="small secondary" message={`Write the checks for ${st.storyId} again? Its ${st.uiFlows.length} flows and their results are replaced.`} busy="Starting..." disabled={busy || !build?.envUrl}>Write its checks again</ConfirmButton> : <PendingButton className="small" busy="Starting..." disabled={busy || !build?.envUrl}>Write its checks</PendingButton>}
                  </form>
                  {st.uiFlows.length > 0 && (
                    <form action={runStoryChecks} className="inline-form">
                      <input type="hidden" name="releaseId" value={releaseId} /><input type="hidden" name="story" value={st.id} /><input type="hidden" name="validation" value="on" />
                      <PendingButton className="small" busy="Starting..." disabled={busy}>Check this story</PendingButton>
                    </form>
                  )}
                </div>
              )}
              {st.uiFlows.map((f) => {
                const steps = parse<string[]>(f.steps, []);
                const pics = `${base}/story/${f.id}?`;
                const failedOnes = f.checks.filter((c) => c.result === "Fail").map((c) => c.id);
                return (
                  <div key={f.id} className="card" style={{ margin: ".5rem 0" }}>
                    <div className="row spread"><strong>Flow {f.no}: {f.name}</strong><Badge tone={matchTone(f.result)}>{f.result}</Badge></div>
                    <p className="muted" style={{ margin: ".3rem 0" }}>
                      {f.page ? <>Opens <code>{f.page}</code></> : <>Finds {f.screen || "its page"} from where signing in lands</>}{steps.length ? <>, then clicks {steps.join(" › ")}</> : null}.
                      {f.summary ? ` ${f.summary}` : ""}{f.runAt ? ` Checked ${f.runAt.toLocaleString("en-IN")} on build ${f.buildNo}.` : ""}
                    </p>
                    {withShot.has(f.id) && (
                      <p style={{ margin: "0 0 .5rem" }}>
                        <a href={`${pics}view=evidence`} target="_blank" rel="noreferrer">Open the evidence picture</a>{" "}
                        <span className="muted">The build after these steps, each failed check boxed with its number. The bug draft links to it.</span>
                      </p>
                    )}
                    <div className="tbox">
                      <table>
                        <thead><tr><th className="num">#</th><th>Kind</th><th>What the story says</th><th>Criteria</th><th>Result</th><th>What the build shows</th><th>Evidence</th></tr></thead>
                        <tbody>
                          {f.checks.map((c) => {
                            const spec = parse<CheckSpec>(c.spec, { fieldType: "any", required: "unknown", options: [], exact: false, fill: [], submit: "", words: [] });
                            const more = detail(c.kind, spec);
                            const failedAt = failedOnes.indexOf(c.id);
                            const boxed = boxesOf(c.box).flow.length > 0;
                            return (
                              <tr key={c.id}>
                                <td className="num">{failedAt >= 0 ? <strong>{failedAt + 1}</strong> : <span className="muted">·</span>}</td>
                                <td>{KIND_NAMES[c.kind] ?? c.kind}</td>
                                <td style={{ minWidth: 200 }}><strong>{c.target}</strong><div>{c.expect}</div>{more && <div className="muted" style={{ fontSize: 12 }}>{more}</div>}</td>
                                <td className="mono" style={{ fontSize: 12 }}>{c.criteria}</td>
                                <td><Badge tone={resultTone(c.result)}>{c.result}</Badge></td>
                                <td style={{ minWidth: 220, fontSize: 13, overflowWrap: "anywhere" }}>{c.actual}</td>
                                <td style={{ whiteSpace: "nowrap", fontSize: 13 }}>
                                  {failedAt >= 0 && boxed && withShot.has(f.id) && <div><a href={`${pics}n=${failedAt}`} target="_blank" rel="noreferrer">Close-up</a></div>}
                                  {checkWithShot.has(c.id) && <div><a href={`${base}/check/${c.id}?view=evidence`} target="_blank" rel="noreferrer">{c.kind === "validation" ? "After pressing save" : "While open"}</a></div>}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <div className="row" style={{ gap: ".4rem", flexWrap: "wrap", marginTop: ".5rem" }}>
                      <form action={runStoryChecks} className="inline-form">
                        <input type="hidden" name="releaseId" value={releaseId} /><input type="hidden" name="story" value={st.id} /><input type="hidden" name="flow" value={f.id} /><input type="hidden" name="validation" value="on" />
                        <PendingButton className="small secondary" busy="Starting..." disabled={busy}>Check this flow</PendingButton>
                      </form>
                      <details>
                        <summary className="muted" style={{ fontSize: ".82rem", cursor: "pointer" }}>Change its page or steps</summary>
                        <form action={saveStoryFlow} className="stack" style={{ marginTop: ".4rem", minWidth: 360 }}>
                          <input type="hidden" name="releaseId" value={releaseId} /><input type="hidden" name="flow" value={f.id} />
                          <label><span>Page</span><input name="page" defaultValue={f.page} placeholder="/boq, or blank to find it by name" /></label>
                          <label><span>Steps, the names of the controls clicked in order</span><input name="steps" defaultValue={steps.join(" › ")} placeholder="New Client BOQ › Items" /></label>
                          <div className="row">
                            <PendingButton className="small" busy="Saving...">Save</PendingButton>
                            <ConfirmButton formAction={removeStoryFlow} className="small secondary" message={`Remove flow ${f.name} and its ${f.checks.length} checks?`} busy="Removing...">Remove this flow</ConfirmButton>
                          </div>
                        </form>
                      </details>
                    </div>
                  </div>
                );
              })}
            </div>
          </details>
        );
      })}
    </div>
  );
}
