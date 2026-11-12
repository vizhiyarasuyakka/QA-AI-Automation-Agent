import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ReleaseNav } from "@/components/ReleaseNav";
import { Notice } from "@/components/Notice";
import { Badge, resultTone } from "@/components/Badge";
import { ConfirmButton } from "@/components/ConfirmButton";
import { PendingButton } from "@/components/PendingButton";
import { EnginePicker } from "@/components/EnginePicker";
import { JobPanel } from "@/components/JobPanel";
import { AutoRefresh } from "@/components/AutoRefresh";
import { flowStates } from "@/lib/flows";
import { runningJob } from "@/lib/jobs";
import { endpointLabel, varsOf, type Check, type Pair } from "@/lib/apitesting";
import { addApiList, clearEndpoints, removeApiTest, removeEndpoint, runApiTests, saveApiTarget, writeApiTests } from "./actions";

export const dynamic = "force-dynamic";

const parse = <T,>(s: string, fallback: T): T => { try { return JSON.parse(s) as T; } catch { return fallback; } };
const kindTone = (k: string) => (k === "Positive" ? "ok" : k === "Negative" ? "warn" : "accent");

const LIST_EXAMPLE = `# Accounts
GET /api/accounts  lists accounts; query page and pageSize (max 100)
POST /api/accounts  creates one {"name": "Acme Ltd", "email": "ops@acme.example", "type": "Customer"}
  name is required, max 120 characters; email must be a valid address; type is Customer or Vendor
GET /api/accounts/{id}  one account; 404 when unknown
DELETE /api/accounts/{id}  removes it

# Sign-in
POST /api/auth/login  {"email": "qa@example.com", "password": "..."}  returns token`;

export default async function ApiTestingPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; err?: string; info?: string }> }) {
  const { id } = await params; const sp = await searchParams;
  const release = await prisma.release.findUnique({ where: { id } });
  if (!release) notFound();
  const [running, job, states, target, endpoints, build] = await Promise.all([
    runningJob(id),
    prisma.generationJob.findFirst({ where: { releaseId: id, kind: { in: ["api-tests", "api-run"] } }, orderBy: { startedAt: "desc" } }),
    flowStates(id),
    prisma.apiTarget.findUnique({ where: { releaseId: id } }),
    prisma.apiEndpoint.findMany({ where: { releaseId: id }, orderBy: { no: "asc" }, include: { tests: { orderBy: { testId: "asc" } } } }),
    prisma.build.findFirst({ where: { releaseId: id }, orderBy: { deployedAt: "desc" }, select: { envUrl: true } }),
  ]);
  const tests = endpoints.flatMap((e) => e.tests);
  const count = (r: string) => tests.filter((t) => t.result === r).length;
  const vars = varsOf(target);
  const suggested = target?.baseUrl || (build?.envUrl ? new URL(build.envUrl).origin : "");
  const busy = !!running;
  const apiJob = running && (running.kind === "api-tests" || running.kind === "api-run") ? running : null;
  const withoutTests = endpoints.filter((e) => !e.tests.length).length;
  const notPassed = tests.filter((t) => t.result !== "Pass").length;
  const here = `/releases/${id}/api-testing`;

  return (
    <>
      <h1>{release.name}: API testing</h1>
      <p className="muted">Step 6. Give the API list, Claude writes positive, negative and edge-case tests for every endpoint, and Playwright sends them from this machine, with no browser. Each test keeps the request it sent and the reply it got; a failed test waits in Bugs and reports as a draft.</p>
      <ReleaseNav releaseId={id} active="api" />
      <Notice searchParams={sp} />

      <div className="card" style={{ marginBottom: "1rem" }}>
        <div className="row spread"><strong>API testing status</strong><Badge tone={states.api.tone}>{states.api.status}</Badge></div>
        <p className="muted" style={{ margin: ".4rem 0 0" }}>{states.api.detail}</p>
      </div>

      {apiJob ? (
        <div className="card loader" role="status" style={{ marginBottom: "1rem", alignItems: "flex-start" }}>
          <AutoRefresh />
          <span className="spinner" aria-hidden="true" />
          <div style={{ flex: 1 }}>
            <strong>{apiJob.kind === "api-tests" ? "Writing the API tests" : "Sending the API tests"}</strong>
            <div className="muted" style={{ margin: ".3rem 0" }}>{apiJob.phase}</div>
            {apiJob.storiesTotal > 0 && <div className="bar" aria-hidden="true"><span style={{ width: `${Math.round((apiJob.storiesDone / apiJob.storiesTotal) * 100)}%`, background: "var(--ok)" }} /></div>}
            <div className="muted" style={{ fontSize: 12 }}>{apiJob.kind === "api-tests" ? `${apiJob.storiesDone} of ${apiJob.storiesTotal} endpoints done, ${apiJob.casesAdded} tests so far.` : `${apiJob.storiesTotal} requests to send.`} You can leave this page; it keeps running.</div>
          </div>
        </div>
      ) : <JobPanel job={job} />}

      <div className="grid-2" style={{ marginBottom: "1rem" }}>
        <div className="card">
          <h3>Where the API is</h3>
          <form action={saveApiTarget} className="stack">
            <input type="hidden" name="releaseId" value={id} />
            <label><span className="req">Base URL</span><input name="baseUrl" defaultValue={target?.baseUrl ?? ""} placeholder={suggested || "https://api.example.com"} required /></label>
            <span className="muted" style={{ fontSize: ".82rem" }}>Relative paths in the list are joined to it.{!target?.baseUrl && suggested ? ` The URL to test in Test execution suggests ${suggested}.` : ""}</span>
            <div className="row">
              <label style={{ flex: 1 }}><span>Sign-in header</span><input name="authHeader" defaultValue={target?.authHeader ?? ""} placeholder="Authorization" /></label>
              <label style={{ flex: 2 }}><span>Its value</span><input name="authValue" type="password" placeholder={target?.authValue ? "Saved. Type to replace." : "Bearer eyJ... or the API key"} autoComplete="off" /></label>
            </div>
            <span className="muted" style={{ fontSize: ".82rem" }}>Sent with every test except the ones that check what happens without sign-in. Kept on this machine only and never shown again. Leave the header blank for an API with no sign-in.</span>
            <label><span>Variables</span><textarea name="vars" rows={3} className="mono" defaultValue={Object.keys(vars).length ? JSON.stringify(vars, null, 1).replace(/\n\s*/g, " ") : ""} placeholder='{"accountId": "acc_123", "email": "qa.user@example.com"}' /></label>
            <span className="muted" style={{ fontSize: ".82rem" }}>Values a test needs from your data, written as {"{{name}}"} in the tests: an existing record&apos;s id, a known email. A test that needs one you have not set is Blocked, not sent.</span>
            <div><PendingButton busy="Saving...">Save</PendingButton></div>
          </form>
        </div>
        <div className="card">
          <h3>API list</h3>
          <form action={addApiList} className="stack">
            <input type="hidden" name="releaseId" value={id} />
            <label><span>Paste the list</span><textarea name="list" rows={7} className="mono" placeholder={LIST_EXAMPLE} /></label>
            <label><span>Or choose files</span><input type="file" name="files" multiple accept=".txt,.md,.csv,.tsv,.json,.yaml,.yml" /></label>
            <span className="muted" style={{ fontSize: ".82rem" }}>One endpoint per line, starting with its method; the words after the path, and any lines under it, are its notes; a # heading groups the ones below it. A CSV with a method column, a Postman collection (JSON) or an OpenAPI document (JSON or YAML) work too. Adding a list again only adds endpoints that are new.</span>
            <div className="row">
              <PendingButton busy="Reading...">Add endpoints</PendingButton>
              {endpoints.length > 0 && <ConfirmButton formAction={clearEndpoints} className="secondary" message={`Remove all ${endpoints.length} endpoints and their ${tests.length} tests?`} busy="Removing..." disabled={busy}>Remove all</ConfirmButton>}
            </div>
          </form>
        </div>
      </div>

      <div className="card" style={{ marginBottom: "1rem" }}>
        <div className="row spread" style={{ alignItems: "flex-start" }}>
          <div>
            <h3 style={{ margin: 0 }}>Tests</h3>
            <p className="muted" style={{ margin: ".3rem 0 .6rem" }}>{endpoints.length} endpoints, {tests.length} tests: {count("Pass")} passed, {count("Fail")} failed, {count("Blocked")} blocked, {count("Not run")} not sent.</p>
          </div>
          {tests.length > 0 && (
            <div className="row">
              <a className="btn small secondary" href={`${here}/export?kind=playwright`}>Download the Playwright project</a>
              <a className="btn small secondary" href={`${here}/export?kind=postman`}>Download as a Postman collection</a>
            </div>
          )}
        </div>
        <EnginePicker flow="api" back={here} />
        <div className="row" style={{ flexWrap: "wrap", gap: ".5rem" }}>
          <form action={writeApiTests} className="inline-form">
            <input type="hidden" name="releaseId" value={id} />
            <input type="hidden" name="scope" value="missing" />
            <PendingButton busy="Starting..." disabled={busy || !withoutTests}>{withoutTests ? `Write tests for ${withoutTests} endpoint${withoutTests === 1 ? "" : "s"} without any` : "Every endpoint has tests"}</PendingButton>
          </form>
          {tests.length > 0 && (
            <form action={writeApiTests} className="inline-form">
              <input type="hidden" name="releaseId" value={id} />
              <input type="hidden" name="scope" value="all" />
              <ConfirmButton className="secondary" message={`Write the tests for all ${endpoints.length} endpoints again? The ${tests.length} tests there now are replaced, with their results.`} busy="Starting..." disabled={busy}>Write them all again</ConfirmButton>
            </form>
          )}
          <form action={runApiTests} className="inline-form">
            <input type="hidden" name="releaseId" value={id} />
            <input type="hidden" name="scope" value="all" />
            <ConfirmButton message={`Send all ${tests.length} requests to ${target?.baseUrl ?? "the API"}? Positive tests can create records there, so point it at a test environment.`} busy="Starting..." disabled={busy || !tests.length || !target?.baseUrl}>Run all tests</ConfirmButton>
          </form>
          {notPassed > 0 && notPassed < tests.length && (
            <form action={runApiTests} className="inline-form">
              <input type="hidden" name="releaseId" value={id} />
              <input type="hidden" name="scope" value="failed" />
              <PendingButton className="secondary" busy="Starting..." disabled={busy || !target?.baseUrl}>Run the {notPassed} not passed</PendingButton>
            </form>
          )}
        </div>
        {!target?.baseUrl && tests.length > 0 && <p className="muted" style={{ margin: ".5rem 0 0", fontSize: ".82rem" }}>Enter the base URL above before running.</p>}
      </div>

      {endpoints.map((e) => {
        const failed = e.tests.filter((t) => t.result === "Fail").length;
        const passed = e.tests.filter((t) => t.result === "Pass").length;
        return (
          <details key={e.id} className="card" style={{ marginBottom: ".75rem" }} open={failed > 0}>
            <summary style={{ cursor: "pointer" }}>
              <span className="row spread" style={{ display: "inline-flex", width: "calc(100% - 1.5rem)" }}>
                <span><strong className="mono">{endpointLabel(e)}</strong>{e.name ? <span className="muted"> {e.name}</span> : null}{e.group ? <span className="muted"> · {e.group}</span> : null}</span>
                <span className="row">
                  {!e.tests.length ? <Badge>No tests</Badge> : <>{failed > 0 && <Badge tone="bad">{failed} failed</Badge>}{passed > 0 && <Badge tone="ok">{passed} passed</Badge>}<Badge>{e.tests.length} tests</Badge></>}
                </span>
              </span>
            </summary>
            <div style={{ marginTop: ".75rem" }}>
              {e.note && <p className="muted" style={{ whiteSpace: "pre-wrap", margin: "0 0 .5rem" }}>{e.note}</p>}
              {e.sample && <pre className="block" style={{ whiteSpace: "pre-wrap", margin: "0 0 .5rem" }}>{e.sample}</pre>}
              <div className="row" style={{ flexWrap: "wrap", gap: ".4rem", marginBottom: ".75rem" }}>
                <form action={writeApiTests} className="inline-form"><input type="hidden" name="releaseId" value={id} /><input type="hidden" name="endpoint" value={e.id} />
                  {e.tests.length ? <ConfirmButton className="small secondary" message={`Write the tests for ${endpointLabel(e)} again? Its ${e.tests.length} tests are replaced.`} busy="Starting..." disabled={busy}>Write its tests again</ConfirmButton> : <PendingButton className="small" busy="Starting..." disabled={busy}>Write its tests</PendingButton>}
                </form>
                {e.tests.length > 0 && <form action={runApiTests} className="inline-form"><input type="hidden" name="releaseId" value={id} /><input type="hidden" name="endpoint" value={e.id} /><PendingButton className="small secondary" busy="Starting..." disabled={busy || !target?.baseUrl}>Run its tests</PendingButton></form>}
                <form action={removeEndpoint} className="inline-form"><input type="hidden" name="releaseId" value={id} /><input type="hidden" name="endpoint" value={e.id} /><ConfirmButton className="small secondary" message={`Remove ${e.method} ${e.path} and its tests?`} busy="Removing..." disabled={busy}>Remove endpoint</ConfirmButton></form>
              </div>
              {e.tests.length > 0 && (
                <div className="tbox">
                  <table>
                    <thead><tr><th>Test</th><th>Kind</th><th>What it proves</th><th>Request</th><th>Expects</th><th>Result</th><th>What happened</th><th></th></tr></thead>
                    <tbody>
                      {e.tests.map((t) => {
                        const checks = parse<Check[]>(t.checks, []);
                        const query = parse<Pair[]>(t.query, []);
                        return (
                          <tr key={t.id}>
                            <td className="mono" style={{ whiteSpace: "nowrap" }}>{t.testId}</td>
                            <td><Badge tone={kindTone(t.kind)}>{t.kind}</Badge></td>
                            <td style={{ minWidth: 180 }}>{t.title}{t.needs && <div className="muted" style={{ fontSize: 12 }}>Needs {t.needs.split(",").map((n) => `{{${n.trim()}}}`).join(", ")}</div>}</td>
                            <td style={{ minWidth: 200 }}>
                              <span className="mono">{t.method} {t.path}{query.length ? `?${query.map((q) => `${q.name}=${q.value}`).join("&")}` : ""}</span>
                              {!t.auth && <div className="muted" style={{ fontSize: 12 }}>without sign-in</div>}
                              {t.body && <pre className="block" style={{ whiteSpace: "pre-wrap", margin: ".3rem 0 0", fontSize: 12, maxHeight: 96, overflow: "auto" }}>{t.body}</pre>}
                            </td>
                            <td style={{ fontSize: 13 }}>Status {t.expectStatus}{checks.map((c, i) => <div key={i} className="mono" style={{ fontSize: 12 }}>{c.path} {c.op} {c.value}</div>)}{t.maxMs > 0 && <div className="muted" style={{ fontSize: 12 }}>within {t.maxMs} ms</div>}</td>
                            <td><Badge tone={resultTone(t.result)}>{t.result}</Badge>{t.runAt && <div className="muted" style={{ fontSize: 11 }}>{t.runAt.toLocaleString("en-IN")}</div>}</td>
                            <td style={{ minWidth: 220, fontSize: 13 }}>
                              <div style={{ overflowWrap: "anywhere" }}>{t.actual}</div>
                              {(t.request || t.response) && (
                                <details style={{ marginTop: ".3rem" }}>
                                  <summary className="muted" style={{ fontSize: 12, cursor: "pointer" }}>Request and reply</summary>
                                  <pre className="block" style={{ whiteSpace: "pre-wrap", fontSize: 12, maxHeight: 260, overflow: "auto" }}>{`${t.request}\n\n--- reply ---\n${t.response}`}</pre>
                                  <a href={`${here}/test/${t.id}`} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>Open as evidence text</a>
                                </details>
                              )}
                            </td>
                            <td><form action={removeApiTest} className="inline-form"><input type="hidden" name="releaseId" value={id} /><input type="hidden" name="test" value={t.id} /><ConfirmButton className="small secondary" message={`Remove ${t.testId}?`} busy="..." disabled={busy}>Remove</ConfirmButton></form></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </details>
        );
      })}

      <div className="card" style={{ marginTop: "1rem" }}>
        <h3>How to test an API here</h3>
        <ol style={{ paddingLeft: "1.2rem", lineHeight: 1.55 }}>
          <li><strong>Where the API is.</strong> Enter the base URL, for example <code>https://qa.example.com</code>, so a path such as <code>/api/accounts</code> becomes <code>https://qa.example.com/api/accounts</code>. If the API wants a sign-in, name the header and give its value: <code>Authorization</code> with <code>Bearer eyJ...</code>, or <code>X-API-Key</code> with the key, or <code>Cookie</code> with the session cookie. Get a token the way your app does: sign in once with the test account and copy it from the sign-in reply or the browser&apos;s network tab. Use a test account; the value stays on this machine.</li>
          <li><strong>The list.</strong> Paste it or upload it. The more you say about each endpoint (required fields, limits, allowed values, the statuses it returns), the sharper the negative and edge tests are, because Claude writes them from your notes and from the field rules in your user stories. Three shapes work:
            <details style={{ marginTop: ".4rem" }}><summary className="muted" style={{ cursor: "pointer" }}>A plain list with notes</summary><pre className="block" style={{ whiteSpace: "pre-wrap" }}>{LIST_EXAMPLE}</pre></details>
            <details><summary className="muted" style={{ cursor: "pointer" }}>A CSV</summary><pre className="block" style={{ whiteSpace: "pre-wrap" }}>{`method,path,name,group,note,body\nGET,/api/accounts,List accounts,Accounts,"page and pageSize, max 100",\nPOST,/api/accounts,Create account,Accounts,"name required, max 120","{""name"": ""Acme Ltd""}"`}</pre></details>
            <details><summary className="muted" style={{ cursor: "pointer" }}>A Postman collection or an OpenAPI document</summary><p className="muted" style={{ margin: ".3rem 0" }}>Postman: right-click the collection, Export, Collection v2.1, then upload the JSON. OpenAPI (Swagger): upload the JSON or YAML your backend serves, often at <code>/openapi.json</code> or <code>/swagger/v1/swagger.json</code>. Folders and tags become groups, and the request schemas become the field rules.</p></details>
          </li>
          <li><strong>Write the tests.</strong> For each endpoint Claude writes one or two <Badge tone="ok">Positive</Badge> tests (a valid call that should succeed), three to five <Badge tone="warn">Negative</Badge> tests (missing fields, wrong types, unknown ids, broken JSON, no sign-in, each of which the API must refuse with a 4xx) and two to four <Badge tone="accent">Edge</Badge> tests (empty strings, longest values, boundary numbers, unicode, huge page sizes, repeats). DELETE endpoints and anything named delete, remove or reset get no positive test, so nothing real is removed. A test that needs a value from your data writes it as <code>{"{{name}}"}</code> and lists it under Needs; add it in Variables, or the test stays Blocked.</li>
          <li><strong>Run them.</strong> Run all tests sends every request from this machine with Playwright Test, two at a time, with no browser. Point it at a test environment: positive tests create records. Each test shows Pass, Fail or Blocked (the API could not be reached, or a variable is missing), the time it took, and under Request and reply exactly what was sent and what came back, with the sign-in value hidden. Every failed test becomes a bug draft in Bugs and reports with the request as its steps and the reply as what happened; a later pass clears a draft nobody has acted on.</li>
          <li><strong>Run them elsewhere.</strong> Download the Playwright project to run the same tests from your machine or CI (<code>npx playwright test</code> with <code>BASE_URL</code>, <code>API_AUTH_HEADER</code>, <code>API_AUTH_VALUE</code> and <code>API_VARS</code> in the environment; the README inside explains), and post <code>results.json</code> to <code>/api/import/playwright</code> as the Playwright scripts page shows. Download as a Postman collection to open the same tests in Postman or run them with <code>newman run collection.json --env-var baseUrl=... --env-var authValue=...</code>; its results import at <code>/api/import/newman</code>.</li>
          <li><strong>Keep it current.</strong> Adding the list again only adds endpoints that are new. Write its tests again on one endpoint replaces that endpoint&apos;s tests after you change its notes. Remove a test that is wrong for your API, or an endpoint that is not part of this release.</li>
        </ol>
      </div>
    </>
  );
}
