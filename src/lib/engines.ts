import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { askClaudeJson, claudeConnection, cliEnv, findClaudeCli, TruncatedError, type JsonRequest } from "./claude";
import { FLOW_LABELS, fitOf, mcpFit, type Flow } from "./skillmap";
import { getSetting, setSetting } from "./webhook";

export { FLOW_LABELS, type Flow };
export type EngineOption = { id: string; label: string; ok: boolean; detail: string; group?: string };

const DEFAULTS: Record<Flow, string> = { testcases: "claude", playwright: "claude", execution: "manual", ui: "browser", api: "claude", bugs: "none" };

export async function selectedEngine(flow: Flow) {
  const chosen = await getSetting(`ENGINE_${flow}`);
  if (chosen) return chosen;
  return flow === "bugs" && (await getSetting("BUG_WEBHOOK_URL")) ? "webhook" : DEFAULTS[flow];
}
export const setEngine = (flow: Flow, id: string) => setSetting(`ENGINE_${flow}`, id);

export type PluginSkill = { plugin: string; dir: string; skill: string; description: string; flows: Flow[]; when: string; tested: boolean };
export type McpEntry = { name: string; status: string; ok: boolean; flows: Flow[]; when: string };

type Inventory = { skills: PluginSkill[]; plugins: { id: string; enabled: boolean; skills: number }[]; mcp: McpEntry[] | null };
const cache = ((globalThis as unknown as { __qaInventory?: { at: number; skills?: Pick<Inventory, "skills" | "plugins">; mcp?: McpEntry[]; mcpChecking?: boolean } }).__qaInventory ??= { at: 0 });

function run(cmd: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve) => execFile(cmd, args, { env: cliEnv(), timeout, windowsHide: true, maxBuffer: 1 << 22 }, (_e, out) => resolve(out)));
}

function describe(file: string): string {
  try {
    const head = readFileSync(file, "utf8").split(/^---\s*$/m)[1] ?? "";
    const hit = head.match(/^description:\s*(.+(?:\n[ \t]+.+)*)/m);
    return hit ? hit[1].replace(/^(>-?|\|-?)\s*/, "").replace(/^["']|["']$/g, "").replace(/\s+/g, " ").trim() : "";
  } catch {
    return "";
  }
}

async function loadPlugins() {
  if (cache.skills && Date.now() - cache.at < 60000) return cache.skills;
  const cli = findClaudeCli();
  const result: Pick<Inventory, "skills" | "plugins"> = { skills: [], plugins: [] };
  if (cli) {
    try {
      for (const p of JSON.parse(await run(cli, ["plugin", "list", "--json"], 20000)) as { id: string; enabled: boolean; scope: string; installPath: string }[]) {
        // Project-scoped plugins belong to other repos, so they are not available to this app.
        if (p.scope === "project") continue;
        const plugin = p.id.split("@")[0];
        const found: PluginSkill[] = [];
        const skillDir = path.join(p.installPath, "skills");
        const cmdDir = path.join(p.installPath, "commands");
        const add = (skill: string, file: string) => {
          if (found.some((s) => s.skill === skill)) return;
          const description = describe(file);
          const fit = fitOf(plugin, skill, description);
          found.push({ plugin, dir: p.installPath, skill, description, flows: fit.flows, when: fit.when, tested: !!fit.tested });
        };
        if (existsSync(skillDir)) for (const d of readdirSync(skillDir)) if (existsSync(path.join(skillDir, d, "SKILL.md"))) add(d, path.join(skillDir, d, "SKILL.md"));
        if (existsSync(cmdDir)) for (const f of readdirSync(cmdDir)) if (f.endsWith(".md")) add(f.slice(0, -3), path.join(cmdDir, f));
        result.plugins.push({ id: plugin, enabled: p.enabled, skills: found.length });
        if (p.enabled) result.skills.push(...found);
      }
    } catch {}
  }
  // Skills installed directly in ~/.claude/skills, outside any plugin.
  const own = path.join(os.homedir(), ".claude", "skills");
  if (existsSync(own)) {
    const found: PluginSkill[] = [];
    for (const d of readdirSync(own)) {
      const file = path.join(own, d, "SKILL.md");
      if (!existsSync(file)) continue;
      const description = describe(file);
      const fit = fitOf("your skills", d, description);
      found.push({ plugin: "your skills", dir: path.join(own, d), skill: d, description, flows: fit.flows, when: fit.when, tested: !!fit.tested });
    }
    if (found.length) {
      result.plugins.push({ id: "your skills", enabled: true, skills: found.length });
      result.skills.push(...found);
    }
  }
  cache.skills = result;
  cache.at = Date.now();
  return result;
}

function checkMcp() {
  const cli = findClaudeCli();
  if (!cli || cache.mcpChecking) return;
  cache.mcpChecking = true;
  void run(cli, ["mcp", "list"], 90000).then((out) => {
    const entries: McpEntry[] = [];
    for (const line of out.split(/\r?\n/)) {
      const hit = line.match(/^(.+?): .* - (.+)$/);
      if (!hit) continue;
      const status = hit[2].replace(/^[^A-Za-z]+/, "");
      entries.push({ name: hit[1], status, ok: /connected/i.test(status) && !/not connected/i.test(status), ...mcpFit(hit[1]) });
    }
    cache.mcp = entries;
  }).finally(() => { cache.mcpChecking = false; });
}

/** Health checks take many seconds, so the page shows the last result and refreshes when this one lands. */
export async function inventory(): Promise<Inventory> {
  const { skills, plugins } = await loadPlugins();
  if (!cache.mcp) checkMcp();
  return { skills, plugins, mcp: cache.mcp ?? null };
}

export function refreshInventory() {
  cache.at = 0;
  cache.skills = undefined;
  cache.mcp = undefined;
  checkMcp();
}

function codexStatus(): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    execFile("codex", ["login", "status"], { timeout: 20000, windowsHide: true, shell: process.platform === "win32" }, (err, out, errOut) => {
      if (!err) return resolve({ ok: true, detail: (out || errOut).trim().split("\n")[0] || "Signed in" });
      resolve({ ok: false, detail: "Install the Codex CLI (npm i -g @openai/codex), then run codex login and sign in with ChatGPT." });
    });
  });
}

export async function engineOptions(flow: Flow): Promise<EngineOption[]> {
  const conn = await claudeConnection();
  const login = conn.via === "login" || !!findClaudeCli();
  if (flow === "execution") {
    return [
      { id: "manual", label: "Manual results", ok: true, detail: "Record results by hand or import them from CI." },
      { id: "chrome", label: "Chrome extension (Claude in Chrome)", ok: login, detail: login ? "Runs cases in your Chrome through the extension." : "Needs the Claude Code login." },
    ];
  }
  if (flow === "bugs") {
    const [mcp, hook, tool] = await Promise.all([getSetting("BUG_MCP_URL"), getSetting("BUG_WEBHOOK_URL"), getSetting("BUG_MCP_TOOL")]);
    return [
      { id: "none", label: "Keep in this app only", ok: true, detail: "Bugs are not sent anywhere." },
      { id: "mcp", label: "MCP connector", ok: !!mcp && !!tool, detail: mcp && tool ? `Calls ${tool} on ${mcp}` : "Add the server and choose its tool in Settings." },
      { id: "webhook", label: "Webhook", ok: !!hook, detail: hook ? `Posts to ${hook}` : "Add the URL in Settings." },
    ];
  }
  const { skills } = await loadPlugins();
  const skillOptions = skills.filter((s) => s.flows.includes(flow)).map((s) => ({ id: `skill:${s.plugin}:${s.skill}`, label: `${s.plugin}:${s.skill}`, group: "Claude plugin skills", ok: login, detail: login ? s.when : "Skills need the Claude Code login." }));
  if (flow === "ui") {
    return [
      { id: "browser", label: "Playwright browser (private, headless)", ok: login, detail: login ? "Claude reads the prototype and tests the build in its own browser." : "Needs the Claude Code login." },
      ...skillOptions,
    ];
  }
  const codex = await codexStatus();
  return [
    { id: "claude", label: `Claude (${conn.via === "api-key" ? "API key" : "your login"})`, ok: conn.ok, detail: conn.detail },
    { id: "codex", label: "ChatGPT (Codex login)", ok: codex.ok, detail: codex.detail },
    ...skillOptions,
  ];
}

/** Null when the chosen engine can run; otherwise what the user must do first. */
export async function engineProblem(flow: Flow): Promise<string | null> {
  const id = await selectedEngine(flow);
  const option = (await engineOptions(flow)).find((o) => o.id === id);
  if (!option) return `The connection chosen for ${FLOW_LABELS[flow]} is no longer available. Choose another.`;
  return option.ok ? null : `${option.label} is not ready for ${FLOW_LABELS[flow]}. ${option.detail}`;
}

export async function skillFor(id: string) {
  if (!id.startsWith("skill:")) return undefined;
  const [, plugin, skill] = id.split(":");
  const found = (await loadPlugins()).skills.find((s) => s.plugin === plugin && s.skill === skill);
  if (!found) throw new Error(`Plugin skill ${plugin}:${skill} is no longer installed.`);
  return { name: `${plugin}:${skill}`, dir: found.dir };
}

export async function askEngine<T>(flow: Flow, req: JsonRequest): Promise<T> {
  const id = await selectedEngine(flow);
  if (id === "codex") return askCodexJson<T>(req);
  return askClaudeJson<T>({ ...req, skill: await skillFor(id) });
}

async function askCodexJson<T>(req: JsonRequest): Promise<T> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "qa-codex-"));
  const schemaFile = path.join(dir, "schema.json");
  const outFile = path.join(dir, "out.json");
  writeFileSync(schemaFile, JSON.stringify(req.schema));
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("codex", ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--output-schema", `"${schemaFile}"`, "--output-last-message", `"${outFile}"`, "-"], { cwd: dir, stdio: ["pipe", "ignore", "pipe"], windowsHide: true, shell: true, timeout: 15 * 60 * 1000 });
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      child.on("error", reject);
      child.stdin.on("error", () => {});
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Codex failed: ${err.slice(0, 300) || `exit ${code}`}`))));
      child.stdin.end(`${req.system}\n\n${req.context}\n\n${req.ask}`);
    });
    try {
      return JSON.parse(readFileSync(outFile, "utf8")) as T;
    } catch {
      throw new TruncatedError("Codex output was not complete JSON.");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
