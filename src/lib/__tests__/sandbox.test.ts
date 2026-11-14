import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../security", () => ({ dockerReady: async () => ({ ok: true, detail: "test" }) }));

const { dockerArgs, forContainer, hostPath, playwrightImage, runPlaywrightInDocker, SANDBOX_RUN_CONFIG, sandboxMode } = await import("../sandbox");

describe("sandbox settings", () => {
  it("is off unless SCRIPT_SANDBOX=docker", () => {
    expect(sandboxMode({} as NodeJS.ProcessEnv)).toBe("host");
    expect(sandboxMode({ SCRIPT_SANDBOX: "docker" } as unknown as NodeJS.ProcessEnv)).toBe("docker");
  });

  it("uses the image that matches the installed Playwright", () => {
    expect(playwrightImage({} as NodeJS.ProcessEnv)).toMatch(/^mcr\.microsoft\.com\/playwright:v\d+\.\d+\.\d+-noble$/);
    expect(playwrightImage({ SCRIPT_SANDBOX_IMAGE: "registry.local/pw:1" } as unknown as NodeJS.ProcessEnv)).toBe("registry.local/pw:1");
  });

  it("reaches this machine as host.docker.internal", () => {
    expect(forContainer("http://localhost:3000/auth/signin")).toBe("http://host.docker.internal:3000");
    expect(forContainer("https://qa.example.com/app")).toBe("https://qa.example.com");
  });

  it("maps the container's screenshot paths back to the run folder", () => {
    expect(hostPath("/work/test-results/a/shot.png", "C:/runs/r1")).toBe(path.join("C:/runs/r1", "test-results", "a", "shot.png"));
    expect(hostPath(undefined, "x")).toBeUndefined();
  });

  it("locks the container down and never puts a value on the command line", () => {
    const args = dockerArgs({ dir: "/runs/r1", nodeModules: "/app/node_modules", name: "qa-run-x", image: "img", envNames: ["BASE_URL", "QA_USER", "QA_PASSWORD"], extraArgs: ["-g", "TC-1"] });
    for (const flag of ["--rm", "--cap-drop=ALL", "no-new-privileges", "--pids-limit", "--memory"]) expect(args).toContain(flag);
    expect(args.slice(args.indexOf("--user"), args.indexOf("--user") + 2)).toEqual(["--user", "pwuser"]);
    expect(args).toContain("/app/node_modules:/work/node_modules:ro");
    expect(args).not.toContain("--ipc=host");
    expect(args.join(" ")).not.toMatch(/QA_PASSWORD=/);
    expect(args.slice(-2)).toEqual(["-g", "TC-1"]);
  });
});

// Runs a real container. Opt in with DOCKER_TESTS=1 (needs Docker and the Playwright image).
describe.runIf(process.env.DOCKER_TESTS === "1")("sandbox in Docker", () => {
  it("runs a spec that cannot see the app's secrets or files, as a non-root user", async () => {
    const base = path.join(process.cwd(), ".qa-runs");
    mkdirSync(base, { recursive: true });
    const dir = mkdtempSync(path.join(base, "sandbox-test-"));
    try {
      mkdirSync(path.join(dir, "tests"));
      writeFileSync(path.join(dir, "playwright.config.ts"), SANDBOX_RUN_CONFIG);
      // This spec deliberately pokes around; the policy guard is not applied here, the container is what is tested.
      writeFileSync(path.join(dir, "tests", "probe.spec.ts"), `import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
test("TC-PROBE-001 the sandbox holds", async ({ page }) => {
  expect(process.env.DATABASE_URL).toBeUndefined();
  expect(process.env.SECRETS_KEY).toBeUndefined();
  expect(process.env.QA_USER).toBe("probe-user");
  expect(existsSync("/work/node_modules/@playwright/test/package.json")).toBe(true);
  expect(existsSync("/work/../.env")).toBe(false);
  expect(process.getuid?.()).not.toBe(0);
  await page.setContent("<h1>sandboxed</h1>");
  await expect(page.getByRole("heading")).toHaveText("sandboxed");
});
`);
      process.env.DATABASE_URL ??= "postgresql://should-not-leak";
      const r = await runPlaywrightInDocker(dir, { BASE_URL: "http://host.docker.internal:9", QA_USER: "probe-user", QA_PASSWORD: "probe-pass" });
      expect(r.error).toBeUndefined();
      const report = JSON.parse(readFileSync(path.join(dir, "results.json"), "utf8"));
      const statuses = JSON.stringify(report.suites).match(/"status":"(\w+)"/g) ?? [];
      expect(statuses.length).toBeGreaterThan(0);
      expect(report.stats.unexpected, r.output.slice(-1500)).toBe(0);
      expect(report.stats.expected).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
