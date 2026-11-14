import type * as TS from "typescript";

/**
 * A Playwright spec runs as Node.js code on this server, so a stored script, written by a model or edited by hand,
 * must only drive the browser. This walks its syntax tree and refuses anything that could reach the host: other
 * modules, process, globalThis, eval, the Function constructor, require or dynamic import.
 *
 * It is a guard, not a sandbox. The run also gets a clean environment without the app's secrets (safeRunEnv),
 * and only a QA Lead or Admin may save a script by hand.
 */
export const ALLOWED_IMPORTS = new Set(["@playwright/test"]);
const BLOCKED_NAMES = new Set(["require", "process", "globalThis", "global", "eval", "Function", "module", "exports", "__dirname", "__filename", "Deno", "Bun", "Reflect", "Proxy", "WebAssembly"]);
const BLOCKED_PROPS = new Set(["constructor", "__proto__", "prototype", "mainModule", "binding", "dlopen"]);

export type PolicyResult = { ok: true } | { ok: false; problems: string[] };

export function checkScriptPolicy(ts: typeof TS, code: string, fileName = "script.spec.ts"): PolicyResult {
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const problems: string[] = [];
  const at = (n: TS.Node) => `line ${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const add = (n: TS.Node, what: string) => { if (problems.length < 20) problems.push(`${at(n)}: ${what}`); };

  // Reading one variable by name is allowed: the run's environment holds only what safeRunEnv passes (BASE_URL,
  // QA_USER, QA_PASSWORD and what Node needs), so there is nothing secret to read. The rest of process is not.
  const envName = /^[A-Z_][A-Z0-9_]*$/;
  const isAllowedEnv = (n: TS.Identifier) => {
    const env = n.parent;
    if (!ts.isPropertyAccessExpression(env) || env.expression !== n || env.name.text !== "env") return false;
    const key = env.parent;
    if (ts.isPropertyAccessExpression(key) && key.expression === env) return envName.test(key.name.text);
    if (ts.isElementAccessExpression(key) && key.expression === env) return ts.isStringLiteral(key.argumentExpression) && envName.test(key.argumentExpression.text);
    // const { QA_USER, QA_PASSWORD } = process.env;
    if (ts.isVariableDeclaration(key) && key.initializer === env && ts.isObjectBindingPattern(key.name)) {
      return key.name.elements.every((el) => !el.dotDotDotToken && envName.test((el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName : el.name as TS.Identifier).text ?? ""));
    }
    return false;
  };

  const visit = (n: TS.Node) => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) {
      const spec = n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) ? n.moduleSpecifier.text : "";
      if (n.moduleSpecifier && !ALLOWED_IMPORTS.has(spec)) add(n, `imports "${spec}"; only @playwright/test may be imported${/^(node:)?(fs|path|os)$/.test(spec) ? " (for an upload, use setInputFiles({ name, mimeType, buffer: Buffer.from(...) }) instead of a temp file)" : ""}`);
    } else if (ts.isImportEqualsDeclaration(n)) {
      add(n, "uses import = require(), which is not allowed");
    } else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      add(n, "uses a dynamic import(), which is not allowed");
    } else if (ts.isMetaProperty(n)) {
      add(n, "uses import.meta, which is not allowed");
    } else if (ts.isIdentifier(n) && BLOCKED_NAMES.has(n.text)) {
      // A property name such as page.process or { require: 1 } is not the global itself.
      const p = n.parent;
      const isPropName = (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n) || (ts.isMethodDeclaration(p) && p.name === n) || (ts.isPropertyDeclaration(p) && p.name === n);
      if (!isPropName && !(n.text === "process" && isAllowedEnv(n))) add(n, n.text === "process" ? "uses process beyond reading one variable such as process.env.QA_USER" : `uses ${n.text}, which is not allowed`);
    } else if (ts.isPropertyAccessExpression(n) && BLOCKED_PROPS.has(n.name.text)) {
      add(n, `reads .${n.name.text}, which is not allowed`);
    } else if (ts.isElementAccessExpression(n)) {
      const k = n.argumentExpression;
      if (!ts.isNumericLiteral(k) && !(ts.isStringLiteral(k) && !BLOCKED_PROPS.has(k.text)) && !ts.isIdentifier(k)) add(n, "uses a computed property name that cannot be checked; use a plain name");
      if (ts.isStringLiteral(k) && BLOCKED_PROPS.has(k.text)) add(n, `reads ["${k.text}"], which is not allowed`);
    } else if (ts.isTaggedTemplateExpression(n) && ts.isIdentifier(n.tag) && BLOCKED_NAMES.has(n.tag.text)) {
      add(n, `uses ${n.tag.text}, which is not allowed`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return problems.length ? { ok: false, problems } : { ok: true };
}

/** Loads typescript lazily (it is large). Fails closed: without the parser, nothing runs. */
export async function scriptPolicy(code: string, fileName?: string): Promise<PolicyResult> {
  try {
    const ts = (await import("typescript")).default;
    return checkScriptPolicy(ts, code, fileName);
  } catch (e) {
    return { ok: false, problems: [`The script could not be checked (${e instanceof Error ? e.message : String(e)}), so it will not run.`] };
  }
}

export const policyMessage = (r: PolicyResult) => (r.ok ? "" : `Blocked by policy: ${r.problems.join("; ")}`);

/** What a run needs from this machine to start Node and find Chrome, and nothing else: no database URL, API keys or tokens. */
const PASS_THROUGH = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "SYSTEMDRIVE", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "COMMONPROGRAMFILES", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "LANG", "LC_ALL", "TZ", "PLAYWRIGHT_BROWSERS_PATH", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "DISPLAY"]);

export function safeRunEnv(extra: Record<string, string>, from: Record<string, string | undefined> = process.env): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(from)) if (v !== undefined && PASS_THROUGH.has(k.toUpperCase())) env[k] = v;
  // NODE_ENV is deliberately not passed; the cast only satisfies Next's typing of ProcessEnv.
  return { ...env, ...extra, CI: "1" } as unknown as NodeJS.ProcessEnv;
}
