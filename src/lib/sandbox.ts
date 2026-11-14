import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isCancelled } from "./jobscope";

/**
 * Playwright scripts in a container (SCRIPT_SANDBOX=docker). The container sees only the run folder and the app's
 * node_modules, read-only: no app files, no .env, no database credentials. It runs as the image's unprivileged user
 * with every Linux capability dropped, no privilege escalation, and limits on memory and processes.
 * The test account goes in through the environment, never on the command line.
 * Without Docker the run fails with a reason; it never falls back to running on the host.
 */
export const sandboxMode = (env = process.env) => (env.SCRIPT_SANDBOX === "docker" ? "docker" : "host");

export function playwrightImage(env = process.env, cwd = process.cwd()): string {
  if (env.SCRIPT_SANDBOX_IMAGE) return env.SCRIPT_SANDBOX_IMAGE;
  let version = "1.56.1";
  try { version = JSON.parse(readFileSync(path.join(cwd, "node_modules", "@playwright", "test", "package.json"), "utf8")).version; } catch {}
  // The browsers in the image must match the installed Playwright exactly.
  return `mcr.microsoft.com/playwright:v${version}-noble`;
}

/** Inside the container, this machine is host.docker.internal, not localhost. */
export function forContainer(raw: string): string {
  const url = new URL(raw);
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)) url.hostname = "host.docker.internal";
  return url.origin;
}

/** The docker run command. Variable names only after -e: their values come from the docker CLI's own environment. */
export function dockerArgs(o: { dir: string; nodeModules: string; name: string; image: string; envNames: string[]; extraArgs: string[] }): string[] {
  return [
    "run", "--rm", "--init", "--name", o.name,
    "--user", "pwuser", "--cap-drop=ALL", "--security-opt", "no-new-privileges",
    "--memory", "2g", "--pids-limit", "512", "--shm-size", "1g",
    "--add-host", "host.docker.internal:host-gateway",
    "-v", `${o.dir}:/work:rw`, "-v", `${o.nodeModules}:/work/node_modules:ro`, "-w", "/work",
    ...o.envNames.flatMap((n) => ["-e", n]),
    o.image,
    "node", "node_modules/@playwright/test/cli.js", "test", "-c", "playwright.config.ts", ...o.extraArgs,
  ];
}

/** The same run settings as on the host, with Chromium from the image instead of the installed Chrome. */
export const SANDBOX_RUN_CONFIG = `import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  timeout: 120_000,
  workers: 1,
  reporter: [["json", { outputFile: "results.json" }]],
  use: { baseURL: process.env.BASE_URL, headless: true, screenshot: "on" },
});
`;

/** Screenshot paths in results.json are the container's; this gives the same file on the host. */
export const hostPath = (p: string | undefined, dir: string) => (p && p.startsWith("/work/") ? path.join(dir, ...p.slice("/work/".length).split("/")) : p);

const RUN_TIMEOUT_MS = 30 * 60 * 1000;

export async function runPlaywrightInDocker(dir: string, env: Record<string, string>, extraArgs: string[] = []): Promise<{ output: string; error?: string }> {
  const { dockerReady } = await import("./security");
  const ready = await dockerReady();
  if (!ready.ok) return { output: "", error: `Scripts run in a container here (SCRIPT_SANDBOX=docker), but Docker is not available: ${ready.detail}` };
  const name = `qa-run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const args = dockerArgs({ dir, nodeModules: path.join(process.cwd(), "node_modules"), name, image: playwrightImage(), envNames: [...Object.keys(env), "CI"], extraArgs });
  const kill = () => spawn("docker", ["kill", name], { windowsHide: true, shell: process.platform === "win32" });
  return new Promise((resolve) => {
    const child = spawn("docker", args, { env: { ...process.env, ...env, CI: "1" }, windowsHide: true, shell: process.platform === "win32" });
    let out = "", stopped = "";
    const stop = (why: string) => { if (stopped) return; stopped = why; kill(); };
    const watch = setInterval(() => { if (isCancelled()) stop("Stopped: the run was cancelled."); }, 2000);
    const timer = setTimeout(() => stop("Stopped: the run took longer than 30 minutes."), RUN_TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => { clearInterval(watch); clearTimeout(timer); resolve({ output: out, error: e.message }); });
    child.on("close", () => { clearInterval(watch); clearTimeout(timer); resolve({ output: stopped ? `${out}\n${stopped}` : out }); });
  });
}
