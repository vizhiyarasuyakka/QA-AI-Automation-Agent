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
import { DEFAULT_WIDTH, SCREEN_WIDTHS } from "@/lib/screencompare";
import { compareScreens, deleteTrigger, findTriggers, markScreen, runUiTest, saveUiTarget } from "./actions";

export const dynamic = "force-dynamic";

const matchTone = (r: string) => (r === "Match" ? "ok" : r === "Mismatch" ? "bad" : r === "Blocked" ? "warn" : undefined);
const showsAsPicture = (mime: string) => mime.startsWith("image/") && mime !== "image/svg+xml";

/** A screenshot that opens at full size in a new tab. */
function Picture({ href, alt }: { href: string; alt: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={href} alt={alt} style={{ width: "100%", border: "1px solid var(--line)" }} />
    </a>
  );
}

export default async function UiTestingPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; err?: string; info?: string }> }) {
  const { id } = await params; const sp = await searchParams;
  const release = await prisma.release.findUnique({ where: { id } });
  if (!release) notFound();
  const running = await runningJob(id);
  const [states, protos, triggers, build, job, shotRows] = await Promise.all([
    flowStates(id),
    prisma.prototype.findMany({ where: { releaseId: id }, orderBy: { screen: "asc" }, select: { id: true, screen: true, fileName: true, module: true, mimeType: true, pagePath: true, matchResult: true, matchSummary: true, matchDiffs: true, matchBuild: true, matchAt: true } }),
    prisma.uiTrigger.findMany({ where: { releaseId: id }, orderBy: [{ screen: "asc" }, { element: "asc" }], select: { id: true, screen: true, element: true, action: true, expected: true, result: true, actual: true, buildNo: true, runAt: true, screenshot: false } }),
    prisma.build.findFirst({ where: { releaseId: id }, orderBy: { deployedAt: "desc" } }),
    prisma.generationJob.findFirst({ where: { releaseId: id, kind: { in: ["ui-extract", "ui-run", "ui-match"] } }, orderBy: { startedAt: "desc" } }),
    prisma.prototype.findMany({ where: { releaseId: id, NOT: { matchShot: null } }, select: { id: true } }),
  ]);
  const withShots = new Set((await prisma.uiTrigger.findMany({ where: { releaseId: id, NOT: { screenshot: null } }, select: { id: true } })).map((t) => t.id));
  const matchShots = new Set(shotRows.map((p) => p.id));
  const rendered = new Set((await prisma.prototype.findMany({ where: { releaseId: id, NOT: { matchProtoShot: null } }, select: { id: true } })).map((p) => p.id));
  const diffShots = new Set((await prisma.prototype.findMany({ where: { releaseId: id, NOT: { matchDiffShot: null } }, select: { id: true } })).map((p) => p.id));
  const count = (r: string) => triggers.filter((t) => t.result === r).length;
  const notRun = count("Not run");
  const compared = protos.filter((p) => p.matchResult !== "Not run");
  const screens = (r: string) => protos.filter((p) => p.matchResult === r).length;
  const notMatching = protos.filter((p) => p.matchResult !== "Match").length;
  const allWarning = "Each screen opens in a hidden Chrome on this machine, signs in when the app asks, and takes under a minute. No Claude plan is used. Results are kept as they come.";

  return (
    <>
      <h1>{release.name}: UI testing</h1>
      <p className="muted">Step 5. Enter the URL to test and the sign-in for it, then check that each screen looks exactly like its prototype: all at once or one by one. A hidden Chrome on this machine opens the app at the prototype's size and signs in when it asks. Free, open-source tools compare the two: Playwright draws both pages and pixelmatch marks every changed pixel. A screen can also be marked by hand. Every difference becomes a bug draft with the pictures.</p>
      <ReleaseNav releaseId={id} active="ui" />
      <Notice searchParams={sp} />

      <div className="card" style={{ marginBottom: "1rem" }}>
        <div className="row spread"><strong>UI testing status</strong><Badge tone={states.ui.tone}>{states.ui.status}</Badge></div>
        <p className="muted" style={{ margin: ".4rem 0 0" }}>{states.ui.detail}</p>
      </div>

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
            <p className="muted" style={{ margin: 0 }}>Each page opens at the prototype's size: the width chosen here for an HTML or SVG prototype, the picture's own size for PNG, JPG or WEBP. pixelmatch counts the pixels that differ; up to 0.5% counts as the same. For an HTML prototype every text on the page is compared too: missing, extra or reworded, and its colour, background, font, size and place. Table cells and numbers are sample data and do not count. The prototype, the app and the changed pixels stay below to check by eye.</p>
            <div className="row">
              <label className="row" style={{ gap: ".4rem", margin: 0 }}><span className="muted">Screen width</span><select name="width" defaultValue={DEFAULT_WIDTH} aria-label="Screen width" style={{ width: "auto" }}>{SCREEN_WIDTHS.map((w) => <option key={w} value={w}>{w}px</option>)}</select></label>
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
                      <td className="num">{p.matchResult === "Not run" ? <span className="muted">-</span> : (JSON.parse(p.matchDiffs) as ScreenDiff[]).length}</td>
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

      <JobPanel job={job} />

      {compared.map((p) => {
        const diffs = JSON.parse(p.matchDiffs) as ScreenDiff[];
        const shots = `/releases/${id}/ui-testing/match/${p.id}?t=${p.matchAt?.getTime() ?? 0}&`;
        return (
          <section key={p.id} className="card" style={{ marginBottom: ".75rem" }}>
            <div className="row spread">
              <h3 style={{ margin: 0, overflowWrap: "anywhere" }}>{p.screen}</h3>
              <Badge tone={matchTone(p.matchResult)}>{p.matchResult}</Badge>
            </div>
            {p.matchSummary && <p className="muted" style={{ margin: ".35rem 0 .6rem" }}>{p.matchSummary}</p>}
            {diffs.length > 0 && (
              <div className="tbox" style={{ marginBottom: ".75rem" }}>
                <table>
                  <thead><tr><th>Element</th><th>Kind</th><th>Prototype shows</th><th>Build shows</th></tr></thead>
                  <tbody>{diffs.map((d, i) => <tr key={i}><td><strong>{d.element}</strong></td><td>{d.kind}</td><td>{d.prototype || <span className="muted">Nothing</span>}</td><td>{d.build || <span className="muted">Nothing</span>}</td></tr>)}</tbody>
                </table>
              </div>
            )}
            <details open={p.matchResult === "Mismatch"}>
              <summary>Prototype, app and changed pixels</summary>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: ".75rem", marginTop: ".5rem" }}>
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
          </section>
        );
      })}
      {screens("Mismatch") > 0 && <p><Link href={`/releases/${id}/bugs`}>Confirm the differences in Bugs and reports</Link></p>}

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
