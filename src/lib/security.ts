import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { Browser } from "playwright-core";
import { syncStages } from "./flows";
import { launchJob, runningJob, type JobCtx } from "./jobs";
import { prisma } from "./prisma";
import { DEFAULT_WIDTH, openApp, openChrome } from "./screencompare";

/*
 * Stage 9: security testing with free tools. The built-in checks open the URL to test signed in, in a hidden Chrome, and
 * look at what a scanner looks at first: HTTPS, the security headers, cookie flags, mixed content, forms, exposed files,
 * open redirects and input echoed back unescaped. The OWASP ZAP baseline scan, run in Docker when it is there, adds its
 * passive rules. Every check is kept, passed or not, so the list says what was looked at; High and Medium findings
 * become bug drafts.
 */

export type Risk = "High" | "Medium" | "Low" | "Info" | "";
export type Finding = { source: "zap" | "check"; check: string; result: "Fail" | "Warn" | "Pass"; risk: Risk; urls: string[]; evidence: string; description: string; solution: string; reference: string; cwe: string };
export const RISK_ORDER: Record<string, number> = { High: 0, Medium: 1, Low: 2, Info: 3, "": 4 };

const ZAP_IMAGE = "zaproxy/zap-stable";
const ZAP_TIMEOUT_MS = 30 * 60_000;
const MAX_PAGES = 15;
const MARKER = `qa<"'x>`;
const REDIRECT_PARAMS = ["redirect", "redirect_uri", "redirectUrl", "return", "returnUrl", "return_to", "next", "url", "callback", "callbackUrl", "goto", "continue", "dest", "destination", "target"];
const EXPOSED = [
  { p: "/.git/HEAD", test: (t: string) => /^ref:/m.test(t), why: "the Git repository is served: its history and source can be downloaded" },
  { p: "/.git/config", test: (t: string) => /\[core\]/.test(t), why: "the Git repository is served: its history and source can be downloaded" },
  { p: "/.env", test: (t: string) => /^[A-Z_][A-Z0-9_]*=/m.test(t), why: "the environment file with secrets is served" },
];

const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300);
const clip = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);
const strip = (html: string) => clip(html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"'), 1500);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
/** ZAP and the built-in checks both report some things; one topic gives one draft, however many checks saw it. */
const TOPICS: [RegExp, string][] = [[/content.security.policy|\bcsp\b/i, "csp"], [/clickjack|x-frame|frame-ancestors/i, "frames"], [/strict-transport|\bhsts\b/i, "hsts"], [/nosniff|x-content-type/i, "nosniff"], [/httponly/i, "httponly"], [/samesite/i, "samesite"], [/secure flag/i, "secure"], [/referrer/i, "referrer"], [/mixed content/i, "mixed"], [/anti-csrf|csrf/i, "csrf"]];
const topicOf = (check: string) => TOPICS.find(([re]) => re.test(check))?.[1];
const isLocal = (host: string) => host === "localhost" || host === "[::1]" || host.endsWith(".localhost") || host.endsWith(".local") || /^(127|10)\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);

/** Whether Docker answers, so the ZAP scan can run. Checked once a minute at most. */
let docker: { at: number; ok: boolean; detail: string } | null = null;
export async function dockerReady(): Promise<{ ok: boolean; detail: string }> {
  if (docker && Date.now() - docker.at < 60_000) return docker;
  const result = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
    const child = spawn("docker", ["version", "--format", "{{.Server.Version}}"], { windowsHide: true, timeout: 10_000, shell: process.platform === "win32" });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", () => resolve({ ok: false, detail: "Docker is not installed, or not on the PATH." }));
    child.on("close", (code) => resolve(code === 0 && out.trim() ? { ok: true, detail: `Docker ${out.trim()}` } : { ok: false, detail: `Docker is not running. ${firstLine(err || out)}`.trim() }));
  });
  docker = { at: Date.now(), ...result };
  return result;
}

type Build = { envUrl: string; loginUser: string; loginPassword: string; appMap: string };
type PageLook = { path: string; status: number; headers: Record<string, string>; forms: { action: string; method: string }[]; passwords: { autocomplete: string }[]; inputs: number };

const LOOK = String.raw`(() => ({
  forms: [...document.forms].map((f) => ({ action: f.getAttribute("action") || "", method: (f.method || "get").toLowerCase() })),
  passwords: [...document.querySelectorAll("input[type=password]")].map((i) => ({ autocomplete: i.getAttribute("autocomplete") || "" })),
  inputs: document.querySelectorAll("input[type=text], input[type=search], input:not([type])").length,
}))()`;

/** The pages the built-in checks visit: where signing in lands, the mapped pages, the prototype pages. */
function pagesOf(build: Build, protoPaths: string[]): string[] {
  let mapped: string[] = [];
  try { mapped = (JSON.parse(build.appMap || "[]") as { path: string }[]).map((p) => p.path); } catch { /* no map yet */ }
  return [...new Set([...mapped, ...protoPaths].filter((p) => p.startsWith("/")))].slice(0, MAX_PAGES);
}

/** What a scanner looks at first, done signed in with Playwright. */
async function builtInChecks(browser: Browser, build: Build, protoPaths: string[], job: JobCtx): Promise<{ findings: Finding[]; blocked?: string }> {
  const findings: Finding[] = [];
  const add = (f: Partial<Finding> & { check: string; result: Finding["result"] }) => findings.push({ source: "check", risk: "", urls: [], evidence: "", description: "", solution: "", reference: "", cwe: "", ...f });
  const home = new URL(build.envUrl);
  const origin = home.origin, https = home.protocol === "https:", local = isLocal(home.hostname);

  const opened = await openApp(browser, { url: null, home: build.envUrl, screen: "", width: DEFAULT_WIDTH, account: { user: build.loginUser, password: build.loginPassword } });
  if ("blocked" in opened) return { findings, blocked: opened.blocked };
  const { page, context } = opened;
  const mixed = new Set<string>();
  page.on("request", (r) => { if (https && r.url().startsWith("http:")) mixed.add(r.url()); });
  const looks: PageLook[] = [];
  try {
    const landing = new URL(page.url());
    const paths = [...new Set([landing.pathname + landing.search, ...pagesOf(build, protoPaths)])].slice(0, MAX_PAGES);
    for (const [i, p] of paths.entries()) {
      await job.set({ phase: `Built-in checks: looking at ${p} (${i + 1} of ${paths.length})` });
      try {
        const res = await page.goto(origin + p, { waitUntil: "commit", timeout: 40_000 });
        await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
        await page.waitForTimeout(1200);
        const seen = await page.evaluate<Pick<PageLook, "forms" | "passwords" | "inputs">>(LOOK).catch(() => ({ forms: [], passwords: [], inputs: 0 }));
        looks.push({ path: p, status: res?.status() ?? 0, headers: Object.fromEntries(Object.entries(res?.headers() ?? {}).map(([k, v]) => [k.toLowerCase(), v])), ...seen });
      } catch (e) {
        job.log(`Built-in checks: ${p} could not be opened. ${firstLine(e)}`);
      }
    }
    const cookies = await context.cookies();
    const at = (p: string) => origin + p;
    const docs = looks.filter((l) => l.status > 0 && l.status < 400);
    const missing = (header: string, test: (v: string) => boolean = (v) => !!v) => docs.filter((l) => !test(l.headers[header] ?? "")).map((l) => at(l.path));
    const headerCheck = (check: string, header: string, risk: Risk, description: string, solution: string, reference: string, cwe: string, test?: (v: string) => boolean, when = true) => {
      if (!when) return;
      const miss = missing(header, test);
      if (miss.length) add({ check, result: risk === "Info" ? "Warn" : "Fail", risk, urls: miss, evidence: `${miss.length} of ${docs.length} pages: ${header} ${test ? "not as needed" : "not sent"}. ${docs.filter((l) => l.headers[header]).slice(0, 2).map((l) => `${l.path}: ${clip(l.headers[header], 120)}`).join("; ")}`.trim(), description, solution, reference, cwe });
      else add({ check, result: "Pass", evidence: `Sent on all ${docs.length} pages.`, urls: docs.map((l) => at(l.path)) });
    };

    // Transport
    if (https) add({ check: "HTTPS in use", result: "Pass", evidence: `${origin} is served over HTTPS.` });
    else if (local) add({ check: "HTTPS in use", result: "Pass", evidence: `${origin} is a local address over HTTP, which is fine on this machine; the HTTPS checks run when the URL to test is a public one.` });
    else add({ check: "HTTPS in use", result: "Fail", risk: "High", urls: [origin], evidence: `${origin} is served over plain HTTP.`, description: "Everything sent, including the sign-in password and session cookies, can be read or changed on the way.", solution: "Serve the application over HTTPS only and redirect HTTP to it.", reference: "https://owasp.org/www-project-web-security-testing-guide/", cwe: "319" });
    headerCheck("Strict-Transport-Security header", "strict-transport-security", "Low", "Without HSTS a browser can be sent to the HTTP version of the site first.", "Send Strict-Transport-Security: max-age=31536000; includeSubDomains on every HTTPS response.", "https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Strict_Transport_Security_Cheat_Sheet.html", "319", undefined, https);
    headerCheck("Content-Security-Policy header", "content-security-policy", "Medium", "Without a Content Security Policy an injected script runs with the page's full rights.", "Send a Content-Security-Policy that names where scripts, styles and frames may come from; start with report-only to find what it breaks.", "https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html", "693");
    const framed = docs.filter((l) => !(l.headers["x-frame-options"] || /frame-ancestors/i.test(l.headers["content-security-policy"] ?? ""))).map((l) => at(l.path));
    if (framed.length) add({ check: "Clickjacking protection (X-Frame-Options or frame-ancestors)", result: "Fail", risk: "Medium", urls: framed, evidence: `${framed.length} of ${docs.length} pages can be put in a frame by another site.`, description: "A page that any site can frame can be laid under a fake page, so clicks land on it unseen.", solution: "Send X-Frame-Options: DENY (or SAMEORIGIN), or frame-ancestors in the Content-Security-Policy.", reference: "https://cheatsheetseries.owasp.org/cheatsheets/Clickjacking_Defense_Cheat_Sheet.html", cwe: "1021" });
    else add({ check: "Clickjacking protection (X-Frame-Options or frame-ancestors)", result: "Pass", evidence: `Framing is refused on all ${docs.length} pages.` });
    headerCheck("X-Content-Type-Options: nosniff", "x-content-type-options", "Low", "Without nosniff a browser may run a file as a script because of what it looks like.", "Send X-Content-Type-Options: nosniff on every response.", "https://developer.mozilla.org/docs/Web/HTTP/Headers/X-Content-Type-Options", "693", (v) => /nosniff/i.test(v));
    headerCheck("Referrer-Policy header", "referrer-policy", "Low", "Without a referrer policy the full page address, which can hold ids and tokens, is sent to every site a link or image leads to.", "Send Referrer-Policy: strict-origin-when-cross-origin or stricter.", "https://developer.mozilla.org/docs/Web/HTTP/Headers/Referrer-Policy", "200");
    headerCheck("Permissions-Policy header", "permissions-policy", "Info", "The browser features a page may use (camera, microphone, geolocation) are not limited.", "Send Permissions-Policy naming the features the application uses, with the rest off.", "https://developer.mozilla.org/docs/Web/HTTP/Headers/Permissions-Policy", "693");
    headerCheck("Cache-Control on signed-in pages", "cache-control", "Info", "A signed-in page that a shared browser or proxy may cache can show one person's data to the next.", "Send Cache-Control: no-store (or private, no-cache) on pages that show a person's data.", "https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html", "525", (v) => /no-store|private|no-cache/i.test(v));
    const leaky = docs.filter((l) => /\d/.test(l.headers["server"] ?? "") || l.headers["x-powered-by"] || l.headers["x-aspnet-version"] || l.headers["x-aspnetmvc-version"]);
    if (leaky.length) add({ check: "Server details in headers", result: "Fail", risk: "Low", urls: leaky.map((l) => at(l.path)), evidence: [...new Set(leaky.flatMap((l) => ["server", "x-powered-by", "x-aspnet-version", "x-aspnetmvc-version"].filter((h) => l.headers[h]).map((h) => `${h}: ${clip(l.headers[h], 80)}`)))].join("; "), description: "Headers name the server software and version, which points an attacker at known holes.", solution: "Remove or blank the Server, X-Powered-By and version headers.", reference: "https://owasp.org/www-project-web-security-testing-guide/", cwe: "200" });
    else add({ check: "Server details in headers", result: "Pass", evidence: "No server software or version is named in the headers." });
    const cors = docs.filter((l) => (l.headers["access-control-allow-origin"] ?? "") === "*" && /true/i.test(l.headers["access-control-allow-credentials"] ?? ""));
    if (cors.length) add({ check: "CORS: any origin with credentials", result: "Fail", risk: "Medium", urls: cors.map((l) => at(l.path)), evidence: "Access-Control-Allow-Origin: * together with Access-Control-Allow-Credentials: true.", description: "Any site can read signed-in responses from a visitor's browser.", solution: "Allow only the origins the application needs, and never * with credentials.", reference: "https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html#cross-origin-resource-sharing", cwe: "942" });
    else add({ check: "CORS: any origin with credentials", result: "Pass", evidence: "No page allows every origin with credentials." });

    // Cookies after signing in
    const named = (list: typeof cookies) => list.map((c) => c.name).join(", ");
    const noHttpOnly = cookies.filter((c) => !c.httpOnly);
    if (noHttpOnly.length) add({ check: "Cookies: HttpOnly flag", result: "Fail", risk: "Low", urls: [origin], evidence: `Readable by page scripts: ${named(noHttpOnly)}.`, description: "A cookie a script can read is stolen by any injected script.", solution: "Set HttpOnly on the session and sign-in cookies.", reference: "https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html", cwe: "1004" });
    else add({ check: "Cookies: HttpOnly flag", result: "Pass", evidence: cookies.length ? `All ${cookies.length} cookies are HttpOnly.` : "No cookies were set." });
    if (https) {
      const insecure = cookies.filter((c) => !c.secure);
      if (insecure.length) add({ check: "Cookies: Secure flag", result: "Fail", risk: "Low", urls: [origin], evidence: `Sent over HTTP too: ${named(insecure)}.`, description: "A cookie without Secure is sent in clear over an HTTP request to the same host.", solution: "Set Secure on every cookie.", reference: "https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html", cwe: "614" });
      else add({ check: "Cookies: Secure flag", result: "Pass", evidence: cookies.length ? `All ${cookies.length} cookies are Secure.` : "No cookies were set." });
    }
    const lax = cookies.filter((c) => !c.sameSite || c.sameSite === "None");
    if (lax.length) add({ check: "Cookies: SameSite attribute", result: "Fail", risk: "Low", urls: [origin], evidence: `No SameSite, or None: ${named(lax)}.`, description: "A cookie sent on requests other sites start lets those sites act as the signed-in person.", solution: "Set SameSite=Lax (or Strict) on the session cookie.", reference: "https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html", cwe: "1275" });
    else add({ check: "Cookies: SameSite attribute", result: "Pass", evidence: cookies.length ? `All ${cookies.length} cookies set SameSite.` : "No cookies were set." });

    // Content
    if (https) {
      if (mixed.size) add({ check: "Mixed content", result: "Fail", risk: "Medium", urls: [...mixed].slice(0, 10), evidence: `${mixed.size} resources loaded over HTTP.`, description: "Scripts or styles loaded over HTTP can be swapped on the way and run inside the HTTPS page.", solution: "Load every resource over HTTPS.", reference: "https://developer.mozilla.org/docs/Web/Security/Mixed_content", cwe: "311" });
      else add({ check: "Mixed content", result: "Pass", evidence: "Every resource loaded over HTTPS." });
      const insecureForms = looks.filter((l) => l.forms.some((f) => /^http:/i.test(f.action)));
      if (insecureForms.length) add({ check: "Forms posting over HTTP", result: "Fail", risk: "Medium", urls: insecureForms.map((l) => at(l.path)), evidence: insecureForms.flatMap((l) => l.forms.filter((f) => /^http:/i.test(f.action)).map((f) => f.action)).slice(0, 5).join(", "), description: "What is typed into the form is sent in clear.", solution: "Post forms to HTTPS addresses only.", reference: "https://owasp.org/www-project-web-security-testing-guide/", cwe: "319" });
      else add({ check: "Forms posting over HTTP", result: "Pass", evidence: "No form posts to an HTTP address." });
    }
    const pw = looks.filter((l) => l.passwords.some((p) => !/off|new-password|current-password/i.test(p.autocomplete)));
    if (pw.length) add({ check: "Password fields: autocomplete", result: "Warn", risk: "Info", urls: pw.map((l) => at(l.path)), evidence: "A password field without autocomplete set to current-password, new-password or off.", description: "Browsers may store the password without a hint of which it is; modern browsers ignore off, so this is informational.", solution: "Set autocomplete=current-password on sign-in and new-password on password change.", reference: "https://developer.mozilla.org/docs/Web/Security/Practical_implementation_guides/Turning_off_form_autocompletion", cwe: "" });
    else if (looks.some((l) => l.passwords.length)) add({ check: "Password fields: autocomplete", result: "Pass", evidence: "Password fields say which password they take." });

    // Exposed files, open redirects and reflected input, with plain requests
    const exposed: string[] = [], exposedWhy: string[] = [];
    for (const e of EXPOSED) {
      try {
        const r = await context.request.get(origin + e.p, { maxRedirects: 0, timeout: 15_000 });
        if (r.status() === 200 && e.test((await r.text()).slice(0, 2000))) { exposed.push(origin + e.p); exposedWhy.push(e.why); }
      } catch { /* not reachable: fine */ }
    }
    if (exposed.length) add({ check: "Exposed repository or environment files", result: "Fail", risk: "High", urls: exposed, evidence: [...new Set(exposedWhy)].join("; "), description: "Source, history or secrets can be downloaded by anyone.", solution: "Block /.git and dotfiles at the web server, and keep them out of the deployed folder.", reference: "https://owasp.org/www-project-web-security-testing-guide/", cwe: "538" });
    else add({ check: "Exposed repository or environment files", result: "Pass", evidence: `${EXPOSED.map((e) => e.p).join(", ")} are not served.` });

    await job.set({ phase: "Built-in checks: trying open redirects" });
    const redirected: string[] = [];
    for (const target of [build.envUrl, origin + "/"]) {
      for (const name of REDIRECT_PARAMS) {
        try {
          const u = new URL(target);
          u.searchParams.set(name, "https://example.org/");
          const r = await context.request.get(u.href, { maxRedirects: 0, timeout: 15_000 });
          if (r.status() >= 300 && r.status() < 400 && /^https?:\/\/example\.org/i.test(r.headers()["location"] ?? "")) redirected.push(u.href);
        } catch { /* a request that fails is not a redirect */ }
      }
    }
    if (redirected.length) add({ check: "Open redirect", result: "Fail", risk: "Medium", urls: redirected, evidence: "The page redirects to any address given in a parameter.", description: "A link to this site can send a person on to a look-alike site after signing in.", solution: "Allow only relative paths, or addresses on a list, in redirect parameters.", reference: "https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html", cwe: "601" });
    else add({ check: "Open redirect", result: "Pass", evidence: `${REDIRECT_PARAMS.length} parameter names tried on the sign-in page and the home page; none redirects off the site.` });

    await job.set({ phase: "Built-in checks: typing into search boxes to see whether input is echoed back unescaped" });
    const reflected: string[] = [], tried: string[] = [];
    for (const l of looks.filter((x) => x.inputs > 0).slice(0, 3)) {
      try {
        await page.goto(origin + l.path, { waitUntil: "commit", timeout: 40_000 });
        await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
        await page.waitForTimeout(1000);
        const boxes = page.locator("input[type=search]:visible, input[placeholder*='earch' i]:visible, input[type=text]:visible");
        const n = Math.min(await boxes.count(), 2);
        for (let i = 0; i < n; i++) {
          const box = boxes.nth(i);
          if (await box.evaluate((e) => !!e.closest("table, [role=row]")).catch(() => true)) continue;
          await box.fill(MARKER).catch(() => {});
          await box.press("Enter").catch(() => {});
          await page.waitForTimeout(1500);
          tried.push(`${l.path} box ${i + 1}`);
          const raw = await page.evaluate<boolean>(`document.documentElement.innerHTML.includes(${JSON.stringify(MARKER)})`).catch(() => false);
          if (raw) reflected.push(page.url());
        }
      } catch (e) {
        job.log(`Built-in checks: input on ${l.path} could not be tried. ${firstLine(e)}`);
      }
    }
    if (reflected.length) add({ check: "Input echoed back unescaped (reflected XSS)", result: "Fail", risk: "High", urls: reflected, evidence: `Typed ${MARKER} into a box; the page's HTML then held it as it is, with the < and quotes unescaped.`, description: "Text a person types, or a link carries, is put into the page as HTML, so a crafted link can run script as the signed-in person.", solution: "Escape every value put into the page, or set it as text rather than HTML.", reference: "https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html", cwe: "79" });
    else add({ check: "Input echoed back unescaped (reflected XSS)", result: "Pass", evidence: tried.length ? `Tried ${tried.length} text boxes (${tried.join(", ")}); the marker never came back unescaped.` : "No text box to try on the pages visited." });
  } finally {
    await context.close().catch(() => {});
  }
  return { findings };
}

type ZapAlert = { name?: string; riskdesc?: string; desc?: string; solution?: string; reference?: string; cweid?: string; count?: string; instances?: { uri?: string; param?: string; evidence?: string }[] };

/** The OWASP ZAP baseline scan in Docker: its spider and passive rules against the URL to test, unauthenticated, two minutes of spidering. */
async function zapBaseline(envUrl: string, job: JobCtx): Promise<{ findings: Finding[]; report: string; note: string }> {
  const ready = await dockerReady();
  if (!ready.ok) return { findings: [], report: "", note: `skipped: ${ready.detail}` };
  const url = new URL(envUrl);
  // The container reaches this machine as host.docker.internal, not localhost.
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)) url.hostname = "host.docker.internal";
  const base = path.join(process.cwd(), ".qa-runs");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, "zap-"));
  try {
    const args = ["run", "--rm", "-v", `${dir}:/zap/wrk/:rw`, ZAP_IMAGE, "zap-baseline.py", "-t", url.href, "-J", "report.json", "-r", "report.html", "-I", "-m", "2", "-T", "15"];
    await job.set({ phase: `ZAP baseline scan of ${url.href}: starting Docker (the first run pulls the image, about 1.5 GB)` });
    const out = await new Promise<string>((resolve) => {
      const child = spawn("docker", args, { windowsHide: true, timeout: ZAP_TIMEOUT_MS, shell: process.platform === "win32" });
      let text = "", pulling = false;
      const take = (d: Buffer) => {
        text += d;
        if (!pulling && /Unable to find image|Pulling from/i.test(text)) { pulling = true; void job.set({ phase: "ZAP baseline scan: pulling the ZAP image (first time only, about 1.5 GB)" }); }
        if (/Spidering|Passive scanning|Total of \d+ URLs/i.test(d.toString())) void job.set({ phase: `ZAP baseline scan of ${url.href}: ${clip(d.toString(), 80)}` });
      };
      child.stdout.on("data", take);
      child.stderr.on("data", take);
      child.on("error", (e) => resolve(`${text}\n${e.message}`));
      child.on("close", () => resolve(text));
    });
    const jsonFile = path.join(dir, "report.json"), htmlFile = path.join(dir, "report.html");
    if (!existsSync(jsonFile)) return { findings: [], report: "", note: `failed: ZAP wrote no report. ${clip(out.slice(-600), 500)}` };
    const report = JSON.parse(readFileSync(jsonFile, "utf8")) as { site?: { alerts?: ZapAlert[] }[] };
    const findings: Finding[] = [];
    for (const site of report.site ?? []) {
      for (const a of site.alerts ?? []) {
        const riskWord = (a.riskdesc ?? "").split(/[\s(]/)[0];
        const risk: Risk = riskWord === "High" ? "High" : riskWord === "Medium" ? "Medium" : riskWord === "Low" ? "Low" : "Info";
        const instances = a.instances ?? [];
        findings.push({
          source: "zap", check: clip(a.name ?? "ZAP alert", 120), result: risk === "High" || risk === "Medium" ? "Fail" : "Warn", risk,
          urls: [...new Set(instances.map((i) => i.uri ?? "").filter(Boolean))].slice(0, 10),
          evidence: `${a.count ?? instances.length} places. ${instances.slice(0, 3).map((i) => [i.param && `parameter ${i.param}`, i.evidence && clip(i.evidence, 120)].filter(Boolean).join(": ")).filter(Boolean).join(" | ")}`.trim(),
          description: strip(a.desc ?? ""), solution: strip(a.solution ?? ""), reference: clip((a.reference ?? "").split(/\s+/)[0] ?? "", 200), cwe: a.cweid ?? "",
        });
      }
    }
    for (const m of out.matchAll(/^PASS: (.+?) \[(\d+)\]/gm)) findings.push({ source: "zap", check: clip(m[1], 120), result: "Pass", risk: "", urls: [], evidence: `ZAP rule ${m[2]} found nothing.`, description: "", solution: "", reference: "", cwe: "" });
    const html = existsSync(htmlFile) ? readFileSync(htmlFile, "utf8") : "";
    const urls = /Total of (\d+) URLs/.exec(out)?.[1];
    return { findings, report: html, note: `ran against ${url.href}${urls ? `, ${urls} URLs spidered` : ""}` };
  } catch (e) {
    return { findings: [], report: "", note: `failed: ${firstLine(e)}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs the scan in the background: the built-in checks, the ZAP baseline scan, or both. Findings replace the last scan's on the page; High and Medium ones become drafts. */
export async function startSecurityScan(releaseId: string, opts: { builtIn: boolean; zap: boolean }): Promise<string | null> {
  if (await runningJob(releaseId)) return "Another run is already in progress for this release.";
  if (!opts.builtIn && !opts.zap) return "Tick at least one of the two scans.";
  const build = await prisma.build.findFirst({ where: { releaseId }, orderBy: { deployedAt: "desc" } });
  if (!build?.envUrl) return "Enter the URL to test in AC Check first.";
  const protoPaths = (await prisma.prototype.findMany({ where: { releaseId }, select: { pagePath: true } })).map((p) => p.pagePath);
  const scan = await prisma.securityScan.create({ data: { releaseId, buildNo: build.number, baseUrl: build.envUrl } });

  await launchJob({
    releaseId, kind: "security", engine: "playwright", after: () => syncStages(releaseId),
    work: async (ctx) => {
      const lines: string[] = [];
      const log = (l: string) => { lines.push(l); ctx.log(l); };
      const findings: Finding[] = [];
      let done = 0, zapNote = opts.zap ? "" : "not run", blocked = "";
      await ctx.set({ phase: "Starting", storiesTotal: (opts.builtIn ? 1 : 0) + (opts.zap ? 1 : 0), storiesDone: 0 });
      if (opts.builtIn) {
        await ctx.set({ phase: "Built-in checks: signing in" });
        let browser: Browser | null = null;
        try {
          browser = await openChrome();
          const r = await builtInChecks(browser, build, protoPaths, ctx);
          findings.push(...r.findings);
          if (r.blocked) { blocked = r.blocked; log(`Built-in checks: blocked. ${r.blocked}`); }
          else log(`Built-in checks: ${r.findings.length} checks, ${r.findings.filter((f) => f.result === "Fail").length} failed, ${r.findings.filter((f) => f.result === "Warn").length} to note.`);
        } catch (e) {
          log(`Built-in checks could not finish. ${firstLine(e)}`);
        } finally {
          await browser?.close().catch(() => {});
        }
        await ctx.set({ storiesDone: ++done });
      }
      if (opts.zap) {
        const z = await zapBaseline(build.envUrl, ctx);
        zapNote = z.note;
        findings.push(...z.findings);
        log(`ZAP baseline scan ${z.note}.${z.findings.length ? ` ${z.findings.filter((f) => f.result !== "Pass").length} alerts, ${z.findings.filter((f) => f.result === "Pass").length} rules passed.` : ""}`);
        if (z.report) await prisma.securityScan.update({ where: { id: scan.id }, data: { zapReport: z.report } });
        await ctx.set({ storiesDone: ++done });
      }
      findings.sort((a, b) => (a.result === "Pass" ? 1 : 0) - (b.result === "Pass" ? 1 : 0) || RISK_ORDER[a.risk] - RISK_ORDER[b.risk] || a.check.localeCompare(b.check));
      if (findings.length) await prisma.securityFinding.createMany({ data: findings.map((f) => ({ releaseId, scanId: scan.id, source: f.source, check: f.check, result: f.result, risk: f.risk, urls: JSON.stringify(f.urls), evidence: f.evidence.slice(0, 2000), description: f.description.slice(0, 2000), solution: f.solution.slice(0, 2000), reference: f.reference.slice(0, 300), cwe: f.cwe })) });
      const count = (r: string) => findings.filter((f) => f.result === "Fail" && f.risk === r).length;
      const warn = findings.filter((f) => f.result === "Warn" || (f.result === "Fail" && (f.risk === "Low" || f.risk === "Info"))).length;
      const summary = `${count("High")} high, ${count("Medium")} medium, ${warn} low or informational, ${findings.filter((f) => f.result === "Pass").length} passed.`;
      const failed = (opts.builtIn && !!blocked && !findings.length) || (opts.zap && !opts.builtIn && zapNote.startsWith("failed"));
      await prisma.securityScan.update({ where: { id: scan.id }, data: { status: failed ? "Failed" : "Done", zap: zapNote, summary, log: lines.join("\n"), finishedAt: new Date() } });

      // Drafts: one per High or Medium finding; a finding that no longer shows clears its draft.
      const keep = new Set<string>();
      for (const f of findings.filter((x) => x.result === "Fail" && (x.risk === "High" || x.risk === "Medium"))) {
        const topic = topicOf(f.check);
        const refKey = `sec:${topic ?? `${f.source}:${slug(f.check)}`}`;
        if (keep.has(refKey)) continue;
        keep.add(refKey);
        const data = {
          source: "security", module: "Security", title: `Security: ${f.check}`.slice(0, 80), severity: f.risk === "High" ? "High" : "Medium", buildNo: build.number,
          steps: [`1. Open ${f.urls[0] ?? build.envUrl}${f.urls.length > 1 ? ` (and ${f.urls.length - 1} more pages)` : ""}`, `2. ${f.source === "zap" ? "Look at the response as ZAP did" : "Look at the response headers, cookies or page as described"}`].join("\n"),
          expected: f.solution || "The check passes.", actual: `${f.evidence}${f.description ? `\n\n${f.description}` : ""}${f.reference ? `\n\nReference: ${f.reference}` : ""}`.slice(0, 3000),
          evidenceUrl: f.source === "zap" ? `/releases/${releaseId}/security/report?scan=${scan.id}` : `/releases/${releaseId}/security`,
        };
        await prisma.bugCandidate.upsert({ where: { releaseId_refKey: { releaseId, refKey } }, update: { ...data, status: "Pending" }, create: { releaseId, refKey, ...data } });
      }
      const stale = (await prisma.bugCandidate.findMany({ where: { releaseId, status: "Pending", refKey: { startsWith: "sec:" } }, select: { refKey: true } })).filter((d) => !keep.has(d.refKey));
      if (stale.length) await prisma.bugCandidate.deleteMany({ where: { releaseId, refKey: { in: stale.map((d) => d.refKey) }, status: "Pending" } });
      log(`Scan finished: ${summary}${keep.size ? ` ${keep.size} findings are in Bugs and reports as drafts.` : ""}`);
      await ctx.set({ gapsLeft: count("High") + count("Medium") });
      return failed ? "Failed" : "Done";
    },
  });
  return null;
}
