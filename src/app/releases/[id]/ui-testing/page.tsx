import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ReleaseNav } from "@/components/ReleaseNav";
import { Notice } from "@/components/Notice";
import { Badge, resultTone } from "@/components/Badge";
import { ConfirmButton } from "@/components/ConfirmButton";
import { EnginePicker } from "@/components/EnginePicker";
import { JobPanel } from "@/components/JobPanel";
import { flowStates } from "@/lib/flows";
import { runningJob } from "@/lib/jobs";
import type { ScreenDiff } from "@/lib/uitesting";
import { DEFAULT_WIDTH, FIELD_KINDS, SCREEN_WIDTHS, type Step } from "@/lib/screencompare";
import { AutoRefresh } from "@/components/AutoRefresh";
import { checkFlow, compareScreens, deleteTrigger, findFlowsAgain, findTriggers, markScreen, removeFlow, runUiTest, saveUiTarget } from "./actions";
import { StoryChecks } from "./StoryChecks";

export const dynamic = "force-dynamic";

const matchTone = (r: string) => (r === "Match" ? "ok" : r === "Mismatch" ? "bad" : r === "Blocked" ? "warn" : undefined);
const showsAsPicture = (mime: string) => mime.startsWith("image/") && mime !== "image/svg+xml";

/** A screenshot that opens at full size in a new tab, loaded when scrolled to. A small one is a close-up in a table. */
function Picture({ href, alt, small = false }: { href: string; alt: string; small?: boolean }) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={href} alt={alt} loading="lazy" style={{ width: small ? 150 : "100%", display: "block", border: "1px solid var(--line)" }} />
    </a>
  );
}

/**
 * A comparison's numbered differences: which fields one side lacks, a link to the evidence picture, and each difference
 * with its close-ups on the prototype and the build. Pictures come from shots, a screen's or a flow's picture address.
 */
function Differences({ diffs, shots, closeUps, evidence, label, anchorId }: { diffs: ScreenDiff[]; shots: string; closeUps: boolean; evidence: boolean; label: string; anchorId: string }) {
  const only = (kind: string) => diffs.flatMap((d, i) => (d.kind === kind ? [{ d, i }] : []));
  const anchor = (i: number) => `diff-${anchorId}-${i + 1}`;
  return (
    <>
      {diffs.some((d) => FIELD_KINDS.has(d.kind)) && (
        <div className="fields" style={{ marginBottom: ".75rem" }}>
          <FieldList title="In the prototype, missing from the build" rows={only("Missing field")} anchor={anchor} />
          <FieldList title="In the build, not in the prototype" rows={only("Extra field")} anchor={anchor} />
        </div>
      )}
      {evidence && (
        <p style={{ margin: "0 0 .6rem" }}>
          <a href={`${shots}view=evidence`} target="_blank" rel="noreferrer">Open the evidence picture</a>{" "}
          <span className="muted">The prototype and the build side by side, each difference boxed with its number from the list. The bug draft links to it.</span>
        </p>
      )}
      {diffs.length > 0 && (
        <div className="tbox" style={{ marginBottom: ".75rem" }}>
          <table>
            <thead><tr><th className="num">#</th><th>Element</th><th>Kind</th><th>Prototype shows</th><th>Build shows</th><th>Evidence: prototype, build</th></tr></thead>
            <tbody>
              {diffs.map((d, i) => (
                <tr key={i} id={anchor(i)}>
                  <td className="num">{i + 1}</td>
                  <td><strong>{d.element}</strong></td>
                  <td>{FIELD_KINDS.has(d.kind) || d.kind === "Missing control" ? <Badge tone="bad">{d.kind}</Badge> : d.kind}</td>
                  <td>{d.prototype || <span className="muted">Nothing</span>}</td>
                  <td>{d.build || <span className="muted">Nothing</span>}</td>
                  <td>
                    {d.at && closeUps ? (
                      <div className="row" style={{ flexWrap: "nowrap", alignItems: "flex-start" }}>
                        <Picture small href={`${shots}view=prototype&n=${i}`} alt={`${d.element} on the prototype of ${label}`} />
                        <Picture small href={`${shots}view=app&n=${i}`} alt={`${d.element} on ${label} in the build`} />
                      </div>
                    ) : <span className="muted">-</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** A flow's clicks as a person would say them. */
const clicks = (steps: Step[]) => steps.map((s) => (s.role === "row" ? "open the first row" : `${s.role} "${s.name}"`)).join(", then ");

/** The fields on one side only, each linked to its numbered row and close-ups below. */
function FieldList({ title, rows, anchor }: { title: string; rows: { d: ScreenDiff; i: number }[]; anchor: (i: number) => string }) {
  return (
    <div>
      <strong>{title} ({rows.length})</strong>
      {rows.length ? (
        <ul style={{ margin: ".3rem 0 0", paddingLeft: "1.1rem" }}>
          {rows.map(({ d, i }) => <li key={i}><a href={`#${anchor(i)}`}>{i + 1}. {d.element}</a> <span className="muted">{d.prototype || d.build}</span></li>)}
        </ul>
      ) : <p className="muted" style={{ margin: ".3rem 0 0" }}>None</p>}
    </div>
  );
}

export default async function UiTestingPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; err?: string; info?: string; screen?: string; flow?: string; story?: string }> }) {
  const { id } = await params; const sp = await searchParams;
  const release = await prisma.release.findUnique({ where: { id } });
  if (!release) notFound();
  const running = await runningJob(id);
  const [states, protos, triggers, build, job, shotRows] = await Promise.all([
    flowStates(id),
    prisma.prototype.findMany({ where: { releaseId: id }, orderBy: { screen: "asc" }, select: { id: true, screen: true, fileName: true, module: true, mimeType: true, pagePath: true, matchResult: true, matchSummary: true, matchDiffs: true, matchBuild: true, matchAt: true, flowsFoundAt: true } }),
    prisma.uiTrigger.findMany({ where: { releaseId: id }, orderBy: [{ screen: "asc" }, { element: "asc" }], select: { id: true, screen: true, element: true, action: true, expected: true, result: true, actual: true, buildNo: true, runAt: true, screenshot: false } }),
    prisma.build.findFirst({ where: { releaseId: id }, orderBy: { deployedAt: "desc" } }),
    prisma.generationJob.findFirst({ where: { releaseId: id, kind: { in: ["ui-extract", "ui-run", "ui-match"] } }, orderBy: { startedAt: "desc" } }),
    prisma.prototype.findMany({ where: { releaseId: id, NOT: { matchShot: null } }, select: { id: true } }),
  ]);
  const withShots = new Set((await prisma.uiTrigger.findMany({ where: { releaseId: id, NOT: { screenshot: null } }, select: { id: true } })).map((t) => t.id));
  const matchShots = new Set(shotRows.map((p) => p.id));
  const rendered = new Set((await prisma.prototype.findMany({ where: { releaseId: id, NOT: { matchProtoShot: null } }, select: { id: true } })).map((p) => p.id));
  const diffShots = new Set((await prisma.prototype.findMany({ where: { releaseId: id, NOT: { matchDiffShot: null } }, select: { id: true } })).map((p) => p.id));
  const flows = await prisma.uiFlow.findMany({ where: { releaseId: id }, orderBy: { createdAt: "asc" }, select: { id: true, prototypeId: true, name: true, steps: true, result: true, summary: true, diffs: true, buildNo: true, runAt: true } });
  const flowShots = new Set((await prisma.uiFlow.findMany({ where: { releaseId: id, NOT: { appShot: null } }, select: { id: true } })).map((f) => f.id));
  const flowsOf = (pid: string) => flows.filter((f) => f.prototypeId === pid);
  // A comparison running now, and what it has checked so far: anything saved since it started.
  const matching = job?.status === "Running" && job.kind === "ui-match" ? job : null;
  const fresh = (at: Date | null) => !!matching && !!at && at >= matching.startedAt;
  // One screen, or one of its flows, opens on its own: the one being checked, not every result.
  const focus = protos.find((p) => p.id === sp.screen) ?? null;
  const single = focus && sp.flow ? flows.find((f) => f.id === sp.flow && f.prototypeId === focus.id) ?? null : null;
  const progress = (() => {
    if (!matching) return { percent: 0, text: "" };
    if (!focus) return { percent: Math.round((matching.storiesDone / Math.max(1, matching.storiesTotal)) * 100), text: `${matching.storiesDone} of ${matching.storiesTotal} screens done.` };
    const mine = single ? [single] : flowsOf(focus.id);
    const listDone = fresh(focus.matchAt), flowsDone = mine.filter((f) => fresh(f.runAt)).length;
    const finding = matching.phase.includes("finding its flows");
    return {
      percent: Math.round((((listDone ? 1 : 0) + flowsDone) / (1 + mine.length)) * 100),
      text: `List page ${listDone ? "done" : "being compared"}; ${finding ? "finding the flows in the prototype, up to three minutes." : `${flowsDone} of ${mine.length} ${mine.length === 1 ? "flow" : "flows"} checked.`}`,
    };
  })();
  const count = (r: string) => triggers.filter((t) => t.result === r).length;
  const notRun = count("Not run");
  const compared = protos.filter((p) => p.matchResult !== "Not run");
  const shown = focus ? [focus] : compared;
  const screens = (r: string) => protos.filter((p) => p.matchResult === r).length;
  const notMatching = protos.filter((p) => p.matchResult !== "Match" || flowsOf(p.id).some((f) => f.result !== "Match")).length;
  const allWarning = "Each screen opens in a hidden Chrome on this machine, signs in when the app asks, and takes under a minute, and each of its flows about as long. Finding a screen's flows the first time takes up to three minutes more. No Claude plan is used. Results are kept as they come.";

  // Where to test and every screen: shown first, or folded away below one screen being looked at on its own.
  const setup = (
    <>
        <form action={saveUiTarget} className="card stack" style={{ marginBottom: "1rem" }}>
          <input type="hidden" name="releaseId" value={id} />
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
            <span className="muted" style={{ fontSize: "12px" }}>The same URL and test account as step 4. Claude signs in only when the app asks, on its own sign-in page; the account is sent to Claude with each run and kept in this app's database on this machine.</span>
          </div>
        </form>
  
        <div className="card" style={{ marginBottom: "1rem" }}>
          <h3>Does the build match the prototype?</h3>
          {!protos.length ? (
            <p className="muted" style={{ margin: 0 }}>No prototype yet. <Link href={`/releases/${id}/documents`}>Add the screens in step 1</Link>, one file per screen.</p>
          ) : !build?.envUrl ? (
            <p className="muted" style={{ margin: 0 }}>Enter the URL to test above first; it is the site the comparison opens.</p>
          ) : (
            <form action={compareScreens} className="stack">
              <input type="hidden" name="releaseId" value={id} />
              <p className="muted" style={{ margin: 0 }}>Each page opens at the prototype's size: the width chosen here for an HTML or SVG prototype, the picture's own size for PNG, JPG or WEBP. pixelmatch counts the pixels that differ; up to 0.5% counts as the same. For an HTML prototype every form field is checked as well: which fields of the prototype the build is missing, which fields the build has that the prototype does not, and a field's label, kind and required mark; a field difference always counts, however few pixels it changes. Every text is compared too: missing, extra or reworded, and its colour, background, font, size and place. Only what is shown counts, not what is hidden or covered. Table cells, table rows and numbers are sample data and do not count. Each difference gets a close-up of the prototype and the build with the spot boxed, and an evidence picture marks them all. With the prototype's flows followed, everything its clicks open is compared the same way: forms, detail views and their tabs, panels and menus, found by clicking through the prototype the first time. Nothing that saves, deletes, sends, imports, exports or signs out is ever clicked on the build.</p>
              <div className="row">
                <label className="row" style={{ gap: ".4rem", margin: 0 }}><span className="muted">Screen width</span><select name="width" defaultValue={DEFAULT_WIDTH} aria-label="Screen width" style={{ width: "auto" }}>{SCREEN_WIDTHS.map((w) => <option key={w} value={w}>{w}px</option>)}</select></label>
                <label className="row" style={{ gap: ".4rem", margin: 0 }} title="Forms, detail views, tabs, panels and menus the prototype's clicks open"><input type="checkbox" name="flows" defaultChecked style={{ width: "auto" }} /><span>Follow the prototype's flows</span></label>
                <button type="submit" className="secondary" name="save" value="1">Save pages</button>
                <ConfirmButton busy="Starting..." disabled={!!running} message={`Compare all ${protos.length} screens with their prototypes? ${allWarning}`}>Compare all {protos.length} {protos.length === 1 ? "screen" : "screens"}</ConfirmButton>
                <ConfirmButton className="secondary" name="scope" value="open" busy="Starting..." disabled={!!running || !notMatching || notMatching === protos.length} message={`Compare the ${notMatching} screens that do not match yet? ${allWarning}`}>Compare the {notMatching} not matching</ConfirmButton>
                {running && <span className="muted">Another run is in progress.</span>}
              </div>
              <div className="tbox">
                <table>
                  <thead><tr><th>Screen</th><th>Module</th><th>Page in the app</th><th>Result</th><th className="num">Differences</th><th></th><th>Mark by hand</th></tr></thead>
                  <tbody>
                    {protos.map((p) => (
                      <tr key={p.id}>
                        <td style={{ overflowWrap: "anywhere" }}><a href={`/releases/${id}/ui-testing/prototype/${p.id}`} target="_blank" rel="noreferrer">{p.screen}</a></td>
                        <td>{p.module || <span className="muted">Any</span>}</td>
                        <td style={{ minWidth: 200 }}><input name={`path:${p.id}`} defaultValue={p.pagePath} placeholder="/accounts, or blank to find it by name" aria-label={`Page for ${p.screen}`} /></td>
                        <td><Badge tone={matchTone(p.matchResult)}>{p.matchResult}</Badge>{p.matchSummary === "Checked by hand." && <div className="muted">By hand</div>}</td>
                        <td className="num">{p.matchResult === "Not run" ? <span className="muted">-</span> : (() => {
                          const diffs = JSON.parse(p.matchDiffs) as ScreenDiff[];
                          const inFields = diffs.filter((d) => FIELD_KINDS.has(d.kind)).length;
                          const own = flowsOf(p.id), off = own.filter((f) => f.result === "Mismatch").length;
                          return <>{diffs.length}{inFields > 0 && <div className="muted">{inFields} in fields</div>}{own.length > 0 && <div className={off ? "bad" : "muted"}>{off} of {own.length} flows differ</div>}</>;
                        })()}</td>
                        <td><button type="submit" className="small secondary" name="screen" value={p.id} disabled={!!running}>Compare</button></td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          <select name={`mark:${p.id}`} defaultValue={p.matchResult === "Not run" ? "Match" : p.matchResult} aria-label={`Result of ${p.screen}`} style={{ width: "auto" }}>{["Match", "Mismatch", "Blocked"].map((x) => <option key={x}>{x}</option>)}</select>
                          <button type="submit" className="small secondary" formAction={markScreen} name="screen" value={p.id} style={{ marginLeft: ".3rem" }}>Save</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted" style={{ margin: 0, fontSize: "12px" }}>{screens("Match")} match, {screens("Mismatch")} differ, {screens("Blocked")} blocked, {screens("Not run")} not run. A screen behind a login is signed in with the test account above; without one it shows as Blocked.</p>
            </form>
          )}
        </div>
    </>
  );

  return (
    <>
      <h1>{release.name}: UI testing</h1>
      <p className="muted">Step 7. Enter the URL to test and the sign-in for it, then check that each screen looks exactly like its prototype: all at once or one by one. A hidden Chrome on this machine opens the app at the prototype's size and signs in when it asks. Free, open-source tools compare the two: Playwright draws both pages, checks every field and text, and pixelmatch marks every changed pixel. A screen can also be marked by hand. Every difference becomes a bug draft with screenshot evidence.</p>
      <ReleaseNav releaseId={id} active="ui" />
      <Notice searchParams={sp} />

      <div className="card" style={{ marginBottom: "1rem" }}>
        <div className="row spread"><strong>UI testing status</strong><Badge tone={states.ui.tone}>{states.ui.status}</Badge></div>
        <p className="muted" style={{ margin: ".4rem 0 0" }}>{states.ui.detail}</p>
      </div>

      {!focus && setup}

      {matching ? (
        <div className="card loader" role="status" style={{ marginBottom: "1rem", alignItems: "flex-start" }}>
          <AutoRefresh />
          <span className="spinner" aria-hidden="true" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong>{focus ? `Checking ${focus.screen}${single ? ` › ${single.name}` : ""}` : `Comparing ${matching.storiesTotal} ${matching.storiesTotal === 1 ? "screen" : "screens"}`}</strong>
            <div className="muted" style={{ overflowWrap: "anywhere" }}>{matching.phase}.</div>
            <div style={{ height: 6, background: "var(--line)", borderRadius: 3, margin: ".45rem 0 .3rem", overflow: "hidden" }}>
              <div style={{ width: `${progress.percent}%`, height: "100%", background: "var(--ok)" }} />
            </div>
            <div className="muted" style={{ fontSize: 12 }}>{progress.text} Each result shows below as soon as it is checked. You can leave this page; the check keeps running.</div>
          </div>
        </div>
      ) : <JobPanel job={job} />}

      {focus && (
        <p className="row spread" style={{ margin: "0 0 .75rem" }}>
          <span>Showing <strong>{focus.screen}</strong> only.</span>
          <Link href={`/releases/${id}/ui-testing`}>Show all screens</Link>
        </p>
      )}

      {shown.map((p) => {
        const diffs = JSON.parse(p.matchDiffs) as ScreenDiff[];
        const shots = `/releases/${id}/ui-testing/match/${p.id}?t=${p.matchAt?.getTime() ?? 0}&`;
        const evidence = p.matchResult === "Mismatch" && matchShots.has(p.id);
        const own = flowsOf(p.id);
        const tally = (r: string) => own.filter((f) => f.result === r).length;
        // This screen is being checked right now: what this run has not reached yet shows as waiting, not as last time's result.
        const live = !!matching && focus?.id === p.id;
        const listPending = live && !fresh(p.matchAt);
        const inRun = (f: { id: string }) => !single || f.id === single.id;
        const next = live && !listPending ? own.find((f) => inRun(f) && !fresh(f.runAt)) : undefined;
        const finding = live && !!matching?.phase.includes("finding its flows");
        return (
          <section key={p.id} className="card" style={{ marginBottom: ".75rem" }}>
            <div className="row spread">
              <h3 style={{ margin: 0, overflowWrap: "anywhere" }}>{focus ? p.screen : <Link href={`/releases/${id}/ui-testing?screen=${p.id}`}>{p.screen}</Link>}</h3>
              {listPending ? <Badge tone="accent">Checking</Badge> : <Badge tone={matchTone(p.matchResult)}>{p.matchResult}</Badge>}
            </div>
            <p className="muted" style={{ margin: ".35rem 0 .6rem" }}>
              List page: {listPending ? "being compared" : `${p.matchResult}${diffs.length ? `, ${diffs.length} differences` : ""}`}.
              {" "}Flows: {own.length ? `${tally("Match")} match, ${tally("Mismatch")} differ, ${tally("Blocked")} blocked, ${tally("Not run")} not run, of ${own.length}` : finding ? "being found" : p.flowsFoundAt ? "none found" : "not found yet"}.
            </p>

            {listPending ? (
              <p className="row" style={{ margin: "0 0 .75rem" }}><span className="spinner small" aria-hidden="true" /> Comparing the list page with the prototype…</p>
            ) : (
              <details open={!focus || !own.length} style={{ marginBottom: ".5rem" }}>
                <summary><strong>List page</strong> <Badge tone={matchTone(p.matchResult)}>{p.matchResult}</Badge>{diffs.length > 0 && <span className="muted"> {diffs.length} differences</span>}</summary>
                {p.matchSummary && <p className="muted" style={{ margin: ".35rem 0 .6rem" }}>{p.matchSummary}</p>}
                <Differences diffs={diffs} shots={shots} closeUps={rendered.has(p.id) && matchShots.has(p.id)} evidence={evidence} label={p.screen} anchorId={p.id} />
                <details open={p.matchResult === "Mismatch"}>
                  <summary>Prototype, app and changed pixels</summary>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: ".75rem", marginTop: ".5rem" }}>
                    {evidence && (
                      <figure style={{ margin: 0, gridColumn: "1 / -1" }}>
                        <figcaption className="muted">Every difference boxed and numbered: prototype left, build right. A dashed box marks where an element is absent.</figcaption>
                        <Picture href={`${shots}view=evidence`} alt={`${p.screen}: prototype and build with each difference marked`} />
                      </figure>
                    )}
                    <figure style={{ margin: 0 }}>
                      <figcaption className="muted">Prototype</figcaption>
                      {rendered.has(p.id) ? <Picture href={`${shots}view=prototype`} alt={`Prototype of ${p.screen}`} />
                        : showsAsPicture(p.mimeType) ? <Picture href={`/releases/${id}/ui-testing/prototype/${p.id}`} alt={`Prototype of ${p.screen}`} />
                        : <a href={`/releases/${id}/ui-testing/prototype/${p.id}`} target="_blank" rel="noreferrer">Open {p.fileName}</a>}
                    </figure>
                    <figure style={{ margin: 0 }}>
                      <figcaption className="muted">The app</figcaption>
                      {matchShots.has(p.id) ? <Picture href={`${shots}view=app`} alt={`${p.screen} in the app`} /> : <span className="muted">No screenshot was saved.</span>}
                    </figure>
                    {diffShots.has(p.id) && (
                      <figure style={{ margin: 0 }}>
                        <figcaption className="muted">Changed pixels in red</figcaption>
                        <Picture href={`${shots}view=diff`} alt={`Pixels of ${p.screen} that differ from the prototype`} />
                      </figure>
                    )}
                  </div>
                </details>
              </details>
            )}

            <div style={{ marginTop: "1rem", borderTop: "1px solid var(--line)", paddingTop: ".75rem" }}>
              <div className="row spread">
                <strong>Flows ({own.length})</strong>
                <form action={findFlowsAgain} className="row" style={{ gap: ".5rem" }}>
                  <input type="hidden" name="releaseId" value={id} />
                  <input type="hidden" name="screen" value={p.id} />
                  {!!p.flowsFoundAt && <button type="submit" className="small secondary" disabled={!!running}>Find flows again</button>}
                </form>
              </div>
              <p className="muted" style={{ margin: ".35rem 0 .5rem" }}>
                {finding ? <><span className="spinner small" aria-hidden="true" /> Finding the flows by clicking through the prototype: every button, row, tab and menu it has. This takes up to three minutes.</>
                  : !p.flowsFoundAt ? "Not found yet. The next comparison with flows clicks through this prototype to find what its buttons, rows, tabs and menus open."
                  : own.length ? "What the prototype's clicks open, each followed on the build with the same clicks and compared field by field and text by text. What the screen itself already showed is left out."
                  : "Clicking through this prototype opened nothing new to compare."}
              </p>
              {own.map((f) => {
                if (live && inRun(f) && !fresh(f.runAt)) {
                  return (
                    <div key={f.id} className="row" style={{ border: "1px solid var(--line)", borderRadius: "var(--radius)", padding: ".5rem .75rem", marginBottom: ".5rem" }}>
                      <strong style={{ overflowWrap: "anywhere" }}>{f.name}</strong>
                      {f === next ? <><span className="spinner small" aria-hidden="true" /><span className="muted">Checking now</span></> : <span className="muted">Waiting</span>}
                    </div>
                  );
                }
                const fdiffs = JSON.parse(f.diffs) as ScreenDiff[];
                const fshots = `/releases/${id}/ui-testing/flow/${f.id}?t=${f.runAt?.getTime() ?? 0}&`;
                const pictured = flowShots.has(f.id);
                return (
                  <details key={f.id} id={`flow-${f.id}`} open={f.result === "Mismatch" && (!focus || single?.id === f.id)} style={{ border: "1px solid var(--line)", borderRadius: "var(--radius)", padding: ".5rem .75rem", marginBottom: ".5rem" }}>
                    <summary>
                      <strong style={{ overflowWrap: "anywhere" }}>{f.name}</strong> <Badge tone={matchTone(f.result)}>{f.result}</Badge>
                      {fdiffs.length > 0 && <span className="muted"> {fdiffs.length} differences{fdiffs.some((d) => FIELD_KINDS.has(d.kind)) ? `, ${fdiffs.filter((d) => FIELD_KINDS.has(d.kind)).length} in fields` : ""}</span>}
                      {live && fresh(f.runAt) && <span className="muted"> · just checked</span>}
                    </summary>
                    <p className="muted" style={{ margin: ".35rem 0 .6rem" }}>Clicks: {clicks(JSON.parse(f.steps) as Step[])}.{f.summary ? ` ${f.summary}` : ""}</p>
                    <Differences diffs={fdiffs} shots={fshots} closeUps={pictured} evidence={f.result === "Mismatch" && pictured} label={`${p.screen} › ${f.name}`} anchorId={f.id} />
                    {pictured && (
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: ".75rem", marginBottom: ".5rem" }}>
                        <figure style={{ margin: 0 }}>
                          <figcaption className="muted">Prototype after these clicks</figcaption>
                          <Picture href={`${fshots}view=prototype`} alt={`Prototype of ${p.screen} after ${f.name}`} />
                        </figure>
                        <figure style={{ margin: 0 }}>
                          <figcaption className="muted">The app after these clicks</figcaption>
                          <Picture href={`${fshots}view=app`} alt={`${p.screen} in the app after ${f.name}`} />
                        </figure>
                      </div>
                    )}
                    <div className="row" style={{ gap: ".5rem" }}>
                      <form action={checkFlow}>
                        <input type="hidden" name="releaseId" value={id} />
                        <input type="hidden" name="flow" value={f.id} />
                        <button type="submit" className="small secondary" disabled={!!running || !build?.envUrl}>Check this flow again</button>
                      </form>
                      <form action={removeFlow}>
                        <input type="hidden" name="releaseId" value={id} />
                        <input type="hidden" name="flow" value={f.id} />
                        <button type="submit" className="small secondary" disabled={!!running}>Stop comparing this flow</button>
                      </form>
                    </div>
                  </details>
                );
              })}
            </div>
          </section>
        );
      })}
      {focus && (
        <details style={{ margin: "1rem 0" }}>
          <summary>All screens, the URL to test and how to compare</summary>
          <div style={{ marginTop: ".75rem" }}>{setup}</div>
        </details>
      )}
      {(screens("Mismatch") > 0 || flows.some((f) => f.result === "Mismatch")) && <p><Link href={`/releases/${id}/bugs`}>Confirm the differences in Bugs and reports</Link></p>}

      {!focus && <StoryChecks releaseId={id} focus={sp.story} running={running} />}

      <details style={{ marginTop: "1rem" }} open={triggers.length > 0}>
        <summary>Test the triggers on each screen ({triggers.length}) <span className="muted">{count("Pass")} passed, {count("Fail")} failed, {count("Blocked")} blocked, {notRun} not run</span></summary>
        <div className="card" style={{ marginTop: ".5rem" }}>
          <p className="muted">Lists each button, link and input the prototype shows, then tries each one on a build. Each failure becomes a bug draft with the exact steps. This part uses Claude.</p>
          <EnginePicker flow="ui" back={`/releases/${id}/ui-testing`} />
          <form action={findTriggers} style={{ marginBottom: ".75rem" }}>
            <input type="hidden" name="releaseId" value={id} />
            <button type="submit" className="secondary" disabled={!protos.length || !!running}>Find triggers in the prototype</button>
          </form>
          {!!build?.envUrl && (
            <form action={runUiTest} className="row" style={{ marginBottom: ".75rem" }}>
              <input type="hidden" name="releaseId" value={id} />
              <select name="scope" defaultValue="notrun" aria-label="Triggers to run" style={{ width: "auto" }}><option value="notrun">Triggers not yet run ({notRun})</option><option value="all">All triggers ({triggers.length})</option></select>
              <button type="submit" className="secondary" disabled={!triggers.length || !!running}>Run UI test</button>
            </form>
          )}
          <div className="tbox">
            <table>
              <thead><tr><th>Screen</th><th>Trigger</th><th>Expected</th><th>Result</th><th>What happened</th><th></th></tr></thead>
              <tbody>
                {triggers.map((t) => (
                  <tr key={t.id}>
                    <td>{t.screen}</td>
                    <td><strong>{t.element}</strong><div className="muted">{t.action}</div></td>
                    <td>{t.expected || <span className="muted">Not shown in the prototype</span>}</td>
                    <td><Badge tone={resultTone(t.result)}>{t.result}</Badge></td>
                    <td>{t.actual}{withShots.has(t.id) && <div><a href={`/releases/${id}/ui-testing/evidence/${t.id}`} target="_blank" rel="noreferrer">Screenshot</a></div>}</td>
                    <td><form action={deleteTrigger} className="inline-form"><input type="hidden" name="id" value={t.id} /><input type="hidden" name="releaseId" value={id} /><button className="small secondary">Remove</button></form></td>
                  </tr>
                ))}
                {!triggers.length && <tr><td colSpan={6} className="muted">No triggers yet.</td></tr>}
              </tbody>
            </table>
          </div>
          {count("Fail") > 0 && <p style={{ marginTop: ".75rem" }}><Link href={`/releases/${id}/bugs`}>Confirm the failures in Bugs and reports</Link></p>}
        </div>
      </details>
    </>
  );
}
