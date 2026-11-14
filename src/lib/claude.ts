import Anthropic from "@anthropic-ai/sdk";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cliUsage, recordAiCall } from "./aiusage";
import { isCancelled, JobCancelled, throwIfCancelled } from "./jobscope";

export type GeneratedCase = {
  tcId: string;
  module: string;
  title: string;
  type: "Positive" | "Negative" | "Boundary" | "Validation" | "Navigation";
  priority: "P1" | "P2" | "P3";
  precondition: string;
  steps: string;
  testData: string;
  expected: string;
  criteria: string;
};

export type ClaudeConnection = { ok: boolean; via: "api-key" | "login" | "none"; detail: string };

/** Output ran past the token limit. The caller retries with less work per request. */
export class TruncatedError extends Error {}

const MODEL = () => process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const MAX_OUTPUT_TOKENS = 64000;
const CLI_TIMEOUT_MS = 15 * 60 * 1000;
const FALLBACK_MODELS = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;

export type JsonRequest = { system: string; context: string; ask: string; schema: Record<string, unknown>; skill?: { name: string; dir: string } };

export function findClaudeCli(): string | null {
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  if (process.env.CLAUDE_CLI_PATH && existsSync(process.env.CLAUDE_CLI_PATH)) return process.env.CLAUDE_CLI_PATH;
  const onPath = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((d) => path.join(d, exe));
  for (const p of [path.join(os.homedir(), ".local", "bin", exe), ...onPath]) if (existsSync(p)) return p;
  const extDir = path.join(os.homedir(), ".vscode", "extensions");
  if (!existsSync(extDir)) return null;
  const versions = readdirSync(extDir).filter((d) => d.startsWith("anthropic.claude-code-")).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const v of versions) {
    const p = path.join(extDir, v, "resources", "native-binary", exe);
    if (existsSync(p)) return p;
  }
  return null;
}

/** The CLI refuses to start inside another Claude Code session, and an empty API key must not shadow the login. */
export function cliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(MAX_OUTPUT_TOKENS) };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.ANTHROPIC_API_KEY;
  return env;
}

/** An API key in .env wins when set. Otherwise the backend runs on this machine's Claude Code login. */
export async function claudeConnection(): Promise<ClaudeConnection> {
  if (process.env.ANTHROPIC_API_KEY) return { ok: true, via: "api-key", detail: "ANTHROPIC_API_KEY from .env" };
  if (apiKeyRequired()) return { ok: false, via: "none", detail: "This deployment requires the organisation's API key (AI_REQUIRE_API_KEY=true). Set ANTHROPIC_API_KEY in .env." };
  const cli = findClaudeCli();
  if (!cli) return { ok: false, via: "none", detail: "Claude Code was not found on this machine. Install it and sign in, or set ANTHROPIC_API_KEY in .env." };
  return new Promise((resolve) => {
    execFile(cli, ["auth", "status"], { env: cliEnv(), timeout: 20000, windowsHide: true }, (_err, stdout) => {
      try {
        const s = JSON.parse(stdout) as { loggedIn?: boolean; subscriptionType?: string; authMethod?: string };
        if (s.loggedIn) return resolve({ ok: true, via: "login", detail: `Claude Code login (${s.subscriptionType ?? s.authMethod ?? "signed in"})` });
      } catch {}
      resolve({ ok: false, via: "none", detail: "Claude Code is not signed in. Run claude auth login, or set ANTHROPIC_API_KEY in .env." });
    });
  });
}

/** Ask for JSON matching a schema. `context` is the long stable part (documents), `ask` the part that changes per request. */
export async function askClaudeJson<T>(req: JsonRequest): Promise<T> {
  const text = process.env.ANTHROPIC_API_KEY && !req.skill ? await viaApi(req) : await viaLogin(req);
  try {
    return JSON.parse(extractJson(text)) as T;
  } catch {
    throw new TruncatedError("Model output was not complete JSON.");
  }
}

async function viaApi(req: JsonRequest): Promise<string> {
  throwIfCancelled();
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = MODEL();
  const started = Date.now();
  const inputChars = req.system.length + req.context.length + req.ask.length;
  try {
    const res = await client.beta.messages
      .stream({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        ...(FALLBACK_MODELS.test(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        system: req.system,
        output_config: { format: { type: "json_schema", schema: req.schema } },
        messages: [{ role: "user", content: [{ type: "text", text: req.context, cache_control: { type: "ephemeral" } }, { type: "text", text: req.ask }] }],
      })
      .finalMessage();
    const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    const u = res.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
    const problem = res.stop_reason === "refusal" ? "refusal" : res.stop_reason === "max_tokens" ? "hit the token limit" : "";
    await recordAiCall({ via: "api", model: res.model ?? model, ok: !problem, error: problem, ms: Date.now() - started, inputChars, outputChars: text.length, inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), outputTokens: u.output_tokens ?? 0 });
    if (res.stop_reason === "refusal") throw new Error("Claude declined this request. Check the document content.");
    if (res.stop_reason === "max_tokens") throw new TruncatedError("Model output hit the token limit.");
    return text;
  } catch (e) {
    if (!(e instanceof TruncatedError) && !(e instanceof Error && e.message.startsWith("Claude declined"))) await recordAiCall({ via: "api", model, ok: false, error: e instanceof Error ? e.message : String(e), ms: Date.now() - started, inputChars });
    throw e;
  }
}

function viaLogin(req: JsonRequest): Promise<string> {
  const tools = req.skill ? ["--tools", "Skill,Read", "--allowedTools", "Skill", "--plugin-dir", req.skill.dir] : ["--tools", ""];
  const ask = req.skill ? `Use the ${req.skill.name} skill for how to do this task. Finish with the JSON result only.\n\n${req.ask}` : req.ask;
  return runCli(["--setting-sources", "", "--strict-mcp-config", ...tools, "--system-prompt", req.system, "--json-schema", JSON.stringify(req.schema)], `${req.context}\n\n${ask}`);
}

/** Ask about files on disk (prototype images, PDFs, HTML). Runs on the login because only Claude Code can read them from here. */
export async function askClaudeWithFiles<T>(req: JsonRequest & { files: { name: string; bytes: Uint8Array }[] }): Promise<T> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "qa-files-"));
  try {
    for (const f of req.files) writeFileSync(path.join(dir, f.name), f.bytes);
    const tools = req.skill ? ["--tools", "Skill,Read", "--allowedTools", "Skill,Read", "--plugin-dir", req.skill.dir] : ["--tools", "Read", "--allowedTools", "Read"];
    const list = req.files.map((f) => f.name).join(", ");
    const text = await runCli(["--setting-sources", "", "--strict-mcp-config", ...tools, "--system-prompt", req.system, "--json-schema", JSON.stringify(req.schema)], `${req.skill ? `Use the ${req.skill.name} skill where it helps. ` : ""}Files in the current folder, read each one: ${list}\n\n${req.context}\n\n${req.ask}`, dir, "cli-files");
    return JSON.parse(extractJson(text)) as T;
  } catch (e) {
    if (e instanceof SyntaxError) throw new TruncatedError("Model output was not complete JSON.");
    throw e;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Drive a private headless browser that can reach only `origin`, and save screenshots in `dir`. */
/** Claude's plan limit stops every later request too, so a run ends there instead of failing item by item. */
export const isPlanLimit = (e: unknown) => /hit your .*limit/i.test(e instanceof Error ? e.message : String(e));

/**
 * headed opens a real Chrome window the person can watch; otherwise the browser runs hidden.
 * origin limits every request to that one site. Leave it out for an app that calls its own API on another port.
 */
export async function askBrowserAgent<T>(req: { system: string; ask: string; schema: Record<string, unknown>; origin?: string; dir: string; headed?: boolean }): Promise<T> {
  const config = { mcpServers: { pw: { command: "npx", args: ["@playwright/mcp@latest", ...(req.headed ? ["--browser", "chrome"] : ["--headless"]), "--isolated", ...(req.origin ? ["--allowed-origins", req.origin] : []), "--output-dir", req.dir] } } };
  const allowed = ["navigate", "navigate_back", "resize", "snapshot", "click", "type", "fill_form", "select_option", "press_key", "hover", "wait_for", "take_screenshot", "console_messages"].map((t) => `mcp__pw__browser_${t}`).join(",");
  const text = await runCli(["--setting-sources", "", "--strict-mcp-config", "--mcp-config", JSON.stringify(config), "--tools", "Read", "--allowedTools", `Read,${allowed}`, "--system-prompt", req.system, "--json-schema", JSON.stringify(req.schema)], req.ask, req.dir, "browser");
  try {
    return JSON.parse(extractJson(text)) as T;
  } catch {
    throw new TruncatedError("The browser run returned an incomplete result.");
  }
}

/** Drive the signed-in Chrome extension. The prompt must describe the only site the agent may touch. */
export async function askChromeJson<T>(req: { system: string; ask: string; schema: Record<string, unknown> }): Promise<T> {
  const text = await runCli(["--chrome", "--setting-sources", "user", "--tools", "", "--allowedTools", "mcp__claude-in-chrome__*", "--system-prompt", req.system, "--json-schema", JSON.stringify(req.schema)], req.ask, os.tmpdir(), "chrome");
  try {
    return JSON.parse(extractJson(text)) as T;
  } catch {
    throw new TruncatedError("Chrome run output was not complete JSON.");
  }
}

/** A shared deployment can require the organisation's API key, so nothing runs on one person's Claude Code login. */
export const apiKeyRequired = () => process.env.AI_REQUIRE_API_KEY === "true";

/** Each call is recorded (time, tokens, cost when Claude Code reports them); a cancelled job's call is stopped. */
function runCli(extra: string[], stdin: string, cwd = os.tmpdir(), via: "cli" | "cli-files" | "browser" | "chrome" = "cli"): Promise<string> {
  try { throwIfCancelled(); } catch (e) { return Promise.reject(e); }
  if (apiKeyRequired()) return Promise.reject(new Error("This deployment allows Claude only through the organisation's API key (AI_REQUIRE_API_KEY=true). Plugin skills, prototype pictures and browser runs need the Claude Code login, so they are off here."));
  const cli = findClaudeCli();
  if (!cli) return Promise.reject(new Error("Claude Code was not found on this machine."));
  const model = MODEL();
  const args = ["-p", "--output-format", "json", "--model", model, "--no-session-persistence", ...extra];
  const skill = extra.includes("--plugin-dir") ? "skill" : "";
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, { cwd, env: cliEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true, timeout: CLI_TIMEOUT_MS });
    const watch = setInterval(() => { if (isCancelled()) child.kill(); }, 2000);
    let out = "";
    let err = "";
    const done = (ok: boolean, error: string, r?: Parameters<typeof cliUsage>[0]) => {
      clearInterval(watch);
      void recordAiCall({ via, model, skill, ok, error, ms: Date.now() - started, inputChars: stdin.length, outputChars: out.length, ...(r ? cliUsage(r) : {}) });
    };
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { done(false, e.message); reject(e); });
    child.stdin.on("error", () => {});
    child.on("close", () => {
      if (isCancelled()) { done(false, "cancelled"); return reject(new JobCancelled("Cancelled while Claude was working.")); }
      let r: { is_error?: boolean; result?: string; structured_output?: unknown; subtype?: string } & Parameters<typeof cliUsage>[0];
      try {
        r = JSON.parse(out);
      } catch {
        const message = `Claude Code failed: ${(err || out || "no output").slice(0, 300)}`;
        done(false, message);
        return reject(new Error(message));
      }
      if (r.structured_output !== undefined) { done(true, "", r); return resolve(JSON.stringify(r.structured_output)); }
      if (r.is_error && r.subtype !== "error_max_structured_output_retries") {
        const message = `Claude Code: ${String(r.result ?? r.subtype).slice(0, 300)}`;
        done(false, message, r);
        return reject(new Error(message));
      }
      done(true, "", r);
      resolve(String(r.result ?? ""));
    });
    child.stdin.end(stdin);
  });
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  throw new Error("Model response did not contain JSON.");
}

/** Parse a pasted pipe table (ChatGPT output) into cases. Header must contain the standard columns. */
export function parsePastedCases(text: string): GeneratedCase[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("|"));
  if (lines.length < 2) return [];
  const header = lines[0].split("|").map((h) => h.trim().toLowerCase());
  const idx = (names: string[]) => header.findIndex((h) => names.some((n) => h.startsWith(n)));
  const col = {
    tcId: idx(["tc id", "tcid", "id"]), module: idx(["module"]), title: idx(["title"]), type: idx(["type"]), priority: idx(["priority"]),
    precondition: idx(["pre-condition", "precondition"]), steps: idx(["steps"]), testData: idx(["test data"]), expected: idx(["expected"]),
    criteria: header.findIndex((h) => h === "ac" || h.startsWith("criteria") || h.startsWith("acceptance")),
  };
  const out: GeneratedCase[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.every((c) => /^:?-+:?$/.test(c) || c === "")) continue;
    const g = (i: number) => (i >= 0 && i < cells.length ? cells[i] : "");
    const tcId = g(col.tcId); if (!tcId) continue;
    out.push({
      tcId, module: g(col.module), title: g(col.title),
      type: (["Positive", "Negative", "Boundary", "Validation", "Navigation"].find((t) => g(col.type).toLowerCase().startsWith(t.toLowerCase())) ?? "Positive") as GeneratedCase["type"],
      priority: (["P1", "P2", "P3"].find((p) => g(col.priority).toUpperCase().startsWith(p)) ?? "P2") as GeneratedCase["priority"],
      precondition: g(col.precondition), steps: g(col.steps).replace(/<br\s*\/?>/gi, "\n"), testData: g(col.testData), expected: g(col.expected), criteria: g(col.criteria),
    });
  }
  return out;
}
