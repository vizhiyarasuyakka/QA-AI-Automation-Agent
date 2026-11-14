import ts from "typescript";
import { describe, expect, it } from "vitest";
import { checkScriptPolicy, safeRunEnv } from "../scriptpolicy";

const check = (code: string) => checkScriptPolicy(ts, code);

const GOOD = `import { test, expect } from "@playwright/test";

test.describe("VR-203 Create invoice", () => {
  test("INV-VR-203-001 creates an invoice @p1", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(process.env.QA_USER!);
    await page.getByLabel("Password").fill(process.env.QA_PASSWORD ?? "");
    const rows = page.getByRole("row");
    for (let i = 0; i < 3; i++) await expect(rows.nth(i)).toBeVisible();
    const items = ["a", "b"];
    expect(items[0]).toBe("a");
    await test.step("1. Open the form", async () => { await page.getByRole("button", { name: "New invoice" }).click(); });
    // VERIFY the toast text
    await expect(page.getByText("Saved")).toBeVisible();
  });
});
`;

describe("script policy", () => {
  it("lets a normal generated spec run", () => {
    expect(check(GOOD)).toEqual({ ok: true });
  });

  it("allows reading one variable by name, since the run's environment holds no secrets", () => {
    expect(check(`const { QA_USER, QA_PASSWORD } = process.env;`).ok).toBe(true);
    expect(check(`const u = process.env["BASE_URL"];`).ok).toBe(true);
    expect(check(`test.skip(!process.env.QA_ORGB_USER, "no second account");`).ok).toBe(true);
    expect(check(`const all = process.env;`).ok).toBe(false);
    expect(check(`const { ...rest } = process.env;`).ok).toBe(false);
    expect(check(`const k = "X"; process.env[k];`).ok).toBe(false);
  });

  it("allows an upload from a buffer, the way the prompt asks", () => {
    expect(check(`await page.setInputFiles("input[type=file]", { name: "a.xlsx", mimeType: "application/octet-stream", buffer: Buffer.from("sample") });`).ok).toBe(true);
  });

  const blocked: [string, string][] = [
    ["node modules", `import { readFileSync } from "node:fs";`],
    ["child_process", `import { execSync } from "child_process";`],
    ["relative helpers", `import { x } from "../../.env";`],
    ["require", `const fs = require("fs");`],
    ["import = require", `import fs = require("fs");`],
    ["dynamic import", `const m = await import("node:fs");`],
    ["eval", `eval("1+1");`],
    ["Function constructor", `new Function("return process")();`],
    ["constructor trick", `(() => 0).constructor("return process")();`],
    ["string constructor access", `(() => 0)["constructor"]("return 1")();`],
    ["computed key", `const o: any = {}; o["con" + "structor"];`],
    ["globalThis", `globalThis.fetch("https://evil.example");`],
    ["process.exit", `process.exit(1);`],
    ["process.mainModule", `process.mainModule.require("fs");`],
    ["import.meta", `console.log(import.meta.url);`],
    ["re-export", `export * from "node:fs";`],
  ];
  for (const [name, code] of blocked) {
    it(`blocks ${name}`, () => {
      const r = check(code);
      expect(r.ok).toBe(false);
    });
  }

  it("names the line of each problem", () => {
    const r = check(`import { test } from "@playwright/test";\n\nconst fs = require("fs");`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]).toMatch(/^line 3:/);
  });

  it("does not flag property names that look like blocked globals", () => {
    expect(check(`const o = { require: 1, process: 2 }; o.process; page.eval;`).ok).toBe(true);
  });
});

describe("run environment", () => {
  it("passes what Node and Chrome need, plus the run variables, and drops the app's secrets", () => {
    const env = safeRunEnv({ BASE_URL: "https://qa.example.com", QA_USER: "u", QA_PASSWORD: "p" }, {
      PATH: "/usr/bin", Path: "C:\\Windows", SystemRoot: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local",
      DATABASE_URL: "postgresql://qa:qa@localhost/db", ANTHROPIC_API_KEY: "sk-ant-x", AUTH_SECRET: "s", SECRETS_KEY: "k", IMPORT_TOKEN: "t", BUG_WEBHOOK_TOKEN: "w",
    });
    expect(env).toMatchObject({ PATH: "/usr/bin", Path: "C:\\Windows", SystemRoot: "C:\\Windows", BASE_URL: "https://qa.example.com", QA_USER: "u", QA_PASSWORD: "p", CI: "1" });
    for (const k of ["DATABASE_URL", "ANTHROPIC_API_KEY", "AUTH_SECRET", "SECRETS_KEY", "IMPORT_TOKEN", "BUG_WEBHOOK_TOKEN"]) expect(env[k]).toBeUndefined();
  });
});
