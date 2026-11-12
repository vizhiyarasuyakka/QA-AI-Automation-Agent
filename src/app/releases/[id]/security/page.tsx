import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ReleaseNav } from "@/components/ReleaseNav";
import { Notice } from "@/components/Notice";
import { Badge } from "@/components/Badge";
import { ConfirmButton } from "@/components/ConfirmButton";
import { JobPanel } from "@/components/JobPanel";
import { AutoRefresh } from "@/components/AutoRefresh";
import { flowStates } from "@/lib/flows";
import { runningJob } from "@/lib/jobs";
import { dockerReady, RISK_ORDER } from "@/lib/security";
import { removeScan, runSecurityScan } from "./actions";

export const dynamic = "force-dynamic";

const riskTone = (risk: string, result: string) => (result === "Pass" ? "ok" : risk === "High" || risk === "Medium" ? "bad" : risk === "Low" ? "warn" : undefined);
const parse = (s: string): string[] => { try { return JSON.parse(s) as string[]; } catch { return []; } };

export default async function SecurityPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; err?: string; info?: string; scan?: string }> }) {
  const { id } = await params; const sp = await searchParams;
  const release = await prisma.release.findUnique({ where: { id } });
  if (!release) notFound();
  const [running, job, states, build, scans, docker] = await Promise.all([
    runningJob(id),
    prisma.generationJob.findFirst({ where: { releaseId: id, kind: "security" }, orderBy: { startedAt: "desc" } }),
    flowStates(id),
    prisma.build.findFirst({ where: { releaseId: id }, orderBy: { deployedAt: "desc" }, select: { envUrl: true, loginUser: true, appMap: true } }),
    prisma.securityScan.findMany({ where: { releaseId: id }, orderBy: { startedAt: "desc" }, take: 10, select: { id: true, status: true, baseUrl: true, buildNo: true, zap: true, summary: true, log: true, startedAt: true, finishedAt: true, zapReport: true, findings: { select: { id: true, source: true, check: true, result: true, risk: true, urls: true, evidence: true, description: true, solution: true, reference: true, cwe: true } } } }),
    dockerReady(),
  ]);
  const scan = scans.find((x) => x.id === sp.scan) ?? scans[0] ?? null;
  const findings = scan ? [...scan.findings].sort((a, b) => (a.result === "Pass" ? 1 : 0) - (b.result === "Pass" ? 1 : 0) || RISK_ORDER[a.risk] - RISK_ORDER[b.risk] || a.check.localeCompare(b.check)) : [];
  const open = findings.filter((f) => f.result !== "Pass"), passed = findings.filter((f) => f.result === "Pass");
  const count = (risk: string) => open.filter((f) => f.risk === risk).length;
  const mine = running?.kind === "security" ? running : null;
  const busy = !!running;
  const mapped = (() => { try { return (JSON.parse(build?.appMap || "[]") as unknown[]).length; } catch { return 0; } })();

  return (
    <>
      <h1>{release.name}: Security Testing</h1>
      <p className="muted">Step 8. Free security tools look at the URL to test and list what fails, check by check. The built-in checks run signed in, in a hidden Chrome on this machine; the OWASP ZAP baseline scan runs in Docker. High and Medium findings become bug drafts.</p>
      <ReleaseNav releaseId={id} active="security" />
      <Notice searchParams={sp} />

      <div className="card" style={{ marginBottom: "1rem" }}>
        <div className="row spread"><strong>Security testing status</strong><Badge tone={states.security.tone}>{states.security.status}</Badge></div>
        <p className="muted" style={{ margin: ".4rem 0 0" }}>{states.security.detail}</p>
      </div>

      {mine ? (
        <div className="card loader" role="status" style={{ marginBottom: "1rem", alignItems: "flex-start" }}>
          <AutoRefresh />
          <span className="spinner" aria-hidden="true" />
          <div style={{ flex: 1 }}>
            <strong>Scanning {build?.envUrl}</strong>
            <div className="muted" style={{ margin: ".3rem 0", overflowWrap: "anywhere" }}>{mine.phase}</div>
            {mine.storiesTotal > 0 && <div className="bar" aria-hidden="true"><span style={{ width: `${Math.round((mine.storiesDone / mine.storiesTotal) * 100)}%`, background: "var(--ok)" }} /></div>}
            <div className="muted" style={{ fontSize: 12 }}>{mine.storiesDone} of {mine.storiesTotal} parts done. The built-in checks take a few minutes; a ZAP scan two to fifteen, plus the image download the first time. You can leave this page.</div>
          </div>
        </div>
      ) : <JobPanel job={job} />}

      <div className="card" style={{ marginBottom: "1rem" }}>
        <h3>Scan</h3>
        {!build?.envUrl ? (
          <p className="muted">Enter the URL to test in <Link href={`/releases/${id}/execution`}>AC Check</Link> first.</p>
        ) : (
          <form action={runSecurityScan} className="stack">
            <input type="hidden" name="releaseId" value={id} />
            <p className="muted" style={{ margin: 0 }}>Scans <code>{build.envUrl}</code>{build.loginUser ? `, signed in as ${build.loginUser} for the built-in checks` : " (no test account saved: the built-in checks see only what a visitor sees)"}{mapped ? `, over the ${mapped} mapped pages` : ""}.</p>
            <label className="inline"><input type="checkbox" name="builtIn" defaultChecked /> Built-in checks: HTTPS, security headers, clickjacking, cookie flags, mixed content, forms, server details, CORS, exposed repository and environment files, open redirects, input echoed back unescaped</label>
            <label className="inline"><input type="checkbox" name="zap" defaultChecked={docker.ok} disabled={!docker.ok} /> OWASP ZAP baseline scan in Docker: its spider for two minutes and its passive rules (about 100), unauthenticated <span className="muted">({docker.detail})</span></label>
            <div className="row">
              <ConfirmButton message={`Scan ${build.envUrl}? The built-in checks type a harmless marker into search boxes and request /.git/HEAD and /.env; ZAP spiders the site unauthenticated. Point it at a test environment.`} busy="Starting..." disabled={busy}>Run security scan</ConfirmButton>
              <span className="muted" style={{ fontSize: ".82rem" }}>Nothing is changed on the site: no form is saved, no record created.</span>
            </div>
          </form>
        )}
      </div>

      {scan && (
        <>
          <div className="row spread" style={{ alignItems: "flex-start" }}>
            <h2 style={{ margin: 0 }}>Findings</h2>
            <span className="muted" style={{ fontSize: ".85rem" }}>Scan of {scan.startedAt.toLocaleString("en-IN")} on build {scan.buildNo}. ZAP: {scan.zap || "not run"}.{scan.zapReport && <> <a href={`/releases/${id}/security/report?scan=${scan.id}`} target="_blank" rel="noreferrer">Open the ZAP report</a></>}</span>
          </div>
          <div className="tiles" style={{ margin: ".75rem 0 1rem" }}>
            <div className="tile"><p className="label">High</p><div className={`big ${count("High") ? "bad" : "ok"}`}>{count("High")}</div></div>
            <div className="tile"><p className="label">Medium</p><div className={`big ${count("Medium") ? "bad" : "ok"}`}>{count("Medium")}</div></div>
            <div className="tile"><p className="label">Low</p><div className="big">{count("Low")}</div></div>
            <div className="tile"><p className="label">Informational</p><div className="big">{count("Info") + count("")}</div></div>
            <div className="tile"><p className="label">Checks passed</p><div className="big ok">{passed.length}</div><p className="sub">of {findings.length}</p></div>
          </div>
          {scan.status === "Failed" && <div className="notice bad" style={{ marginBottom: "1rem" }}>This scan did not finish. {scan.log.split("\n").slice(-2).join(" ")}</div>}
          <div className="card" style={{ marginBottom: "1rem" }}>
            <h3>What fails, and where</h3>
            {!open.length ? <p className="muted">Nothing. Every check passed.</p> : (
              <div className="tbox">
                <table>
                  <thead><tr><th>Risk</th><th>Check</th><th>Where</th><th>What was found</th><th>How to fix it</th><th>By</th></tr></thead>
                  <tbody>
                    {open.map((f) => {
                      const urls = parse(f.urls);
                      return (
                        <tr key={f.id}>
                          <td><Badge tone={riskTone(f.risk, f.result)}>{f.risk || "Info"}</Badge></td>
                          <td style={{ minWidth: 180 }}><strong>{f.check}</strong>{f.cwe && <div className="muted" style={{ fontSize: 12 }}>CWE-{f.cwe}</div>}</td>
                          <td style={{ minWidth: 220, maxWidth: 340, fontSize: 12, overflowWrap: "anywhere" }}>{urls.slice(0, 3).map((u) => <div key={u}>{u}</div>)}{urls.length > 3 && <div className="muted">and {urls.length - 3} more</div>}</td>
                          <td style={{ minWidth: 220, fontSize: 13, overflowWrap: "anywhere" }}>{f.evidence}{f.description && <details><summary className="muted" style={{ fontSize: 12, cursor: "pointer" }}>Why it matters</summary><div style={{ fontSize: 12 }}>{f.description}</div></details>}</td>
                          <td style={{ minWidth: 220, fontSize: 13 }}>
                            {f.solution.length > 320 ? <>{f.solution.slice(0, 320)}… <details><summary className="muted" style={{ fontSize: 12, cursor: "pointer" }}>The rest</summary><div style={{ fontSize: 12 }}>{f.solution.slice(320)}</div></details></> : f.solution}
                            {f.reference && <div><a href={f.reference} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>Reference</a></div>}
                          </td>
                          <td className="muted" style={{ fontSize: 12 }}>{f.source === "zap" ? "ZAP" : "Built-in"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {count("High") + count("Medium") > 0 && <p style={{ marginTop: ".75rem" }}><Link href={`/releases/${id}/bugs`}>Confirm the High and Medium findings in Bugs and reports</Link></p>}
          </div>
          <details className="card" style={{ marginBottom: "1rem" }}>
            <summary>Checks that passed ({passed.length})</summary>
            <table style={{ marginTop: ".5rem" }}>
              <thead><tr><th>Check</th><th>What was seen</th><th>By</th></tr></thead>
              <tbody>{passed.map((f) => <tr key={f.id}><td>{f.check}</td><td className="muted" style={{ fontSize: 13 }}>{f.evidence}</td><td className="muted" style={{ fontSize: 12 }}>{f.source === "zap" ? "ZAP" : "Built-in"}</td></tr>)}</tbody>
            </table>
          </details>
          {scan.log && <details style={{ marginBottom: "1rem" }}><summary className="muted">Scan log</summary><pre className="block" style={{ whiteSpace: "pre-wrap" }}>{scan.log}</pre></details>}
          {scans.length > 1 && (
            <details style={{ marginBottom: "1rem" }}>
              <summary className="muted">Earlier scans ({scans.length - 1})</summary>
              <table style={{ marginTop: ".5rem" }}>
                <thead><tr><th>When</th><th>Build</th><th>Result</th><th></th></tr></thead>
                <tbody>{scans.map((x) => <tr key={x.id}><td><Link href={`/releases/${id}/security?scan=${x.id}`}>{x.startedAt.toLocaleString("en-IN")}</Link>{x.id === scan.id && " (shown)"}</td><td>{x.buildNo}</td><td>{x.status === "Done" ? x.summary : x.status}</td><td><form action={removeScan} className="inline-form"><input type="hidden" name="releaseId" value={id} /><input type="hidden" name="scan" value={x.id} /><ConfirmButton className="small secondary" message="Remove this scan and its findings?" busy="Removing..." disabled={busy}>Remove</ConfirmButton></form></td></tr>)}</tbody>
              </table>
            </details>
          )}
        </>
      )}

      <div className="card">
        <h3>How security testing works here</h3>
        <ol style={{ paddingLeft: "1.2rem", lineHeight: 1.55 }}>
          <li><strong>Built-in checks</strong> open the URL to test in a hidden Chrome, sign in with the test account from AC Check, and visit the mapped pages (up to 15). They read the response headers (HTTPS, Strict-Transport-Security, Content-Security-Policy, X-Frame-Options or frame-ancestors, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, Cache-Control, Server and X-Powered-By, CORS), the cookies set after signing in (HttpOnly, Secure, SameSite), resources and forms loaded over HTTP, password fields, whether <code>/.git/HEAD</code>, <code>/.git/config</code> or <code>/.env</code> are served, whether redirect-style parameters send a visitor off the site, and whether text typed into a search box comes back in the page unescaped. Each check is listed with Pass, or its risk, where it was seen, what was found and how to fix it.</li>
          <li><strong>OWASP ZAP baseline</strong> is the free scanner&apos;s passive mode: it spiders the site for two minutes as a visitor (not signed in) and runs about a hundred passive rules on everything it sees: headers, cookies, information leaks, vulnerable JavaScript libraries, and more. It runs in Docker with <code>docker run --rm -v &lt;folder&gt;:/zap/wrk/:rw zaproxy/zap-stable zap-baseline.py -t &lt;url&gt; -J report.json -r report.html -I</code>; a local address is reached as <code>host.docker.internal</code>. Its HTML report opens from the findings header. Nothing is attacked: an active scan, which does try injections, is not run here.</li>
          <li><strong>Risk</strong> follows ZAP&apos;s scale: High and Medium must be fixed and become bug drafts in Bugs and reports; Low and Informational are listed to decide on. A later scan that no longer finds something clears its draft.</li>
          <li><strong>Gate 5</strong> reads this stage: Security Testing is Done when the latest scan has nothing High or Medium.</li>
          <li><strong>Not covered</strong>: authenticated scanning by ZAP, active attacks, dependency audits of the code and load tests. Run <code>npm audit</code> in the application&apos;s own repository for its dependencies.</li>
        </ol>
      </div>
    </>
  );
}
