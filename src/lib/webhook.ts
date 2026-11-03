import { mcpCallTool, renderArgs } from "./mcp";
import { prisma } from "./prisma";

export async function getSetting(key: string, fallback = ""): Promise<string> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row?.value ?? process.env[key] ?? fallback;
}

export async function setSetting(key: string, value: string) {
  await prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
}

export const REPORT_FIELDS = ["release", "build", "total", "passed", "failed", "blocked", "notRun", "passRate", "summary", "failedCases", "results", "sentAt"];
export const BUG_FIELDS = ["bugId", "title", "module", "severity", "priority", "status", "storyId", "testCaseId", "release", "environment", "buildNo", "browser", "precondition", "steps", "testData", "expected", "actual", "evidenceUrl", "reproducedByHuman", "workaround", "loggedAt", "description"];

/** Send the bug through the connection chosen for bug logging. Records the outcome on the bug row. */
export async function pushBug(bugId: string) {
  const bug = await prisma.bug.findUnique({ where: { id: bugId }, include: { story: true, testCase: true, release: true } });
  if (!bug) return;
  const engine = (await getSetting("ENGINE_bugs")) || (await getSetting("BUG_WEBHOOK_URL") ? "webhook" : "none");
  const record = (webhookStatus: string, webhookResponse: string) => prisma.bug.update({ where: { id: bugId }, data: { webhookStatus, webhookResponse: webhookResponse.slice(0, 500) } });
  if (engine === "none") return void (await record("not sent", "Bug logging is set to keep bugs in this app only"));
  const url = await getSetting("BUG_WEBHOOK_URL");
  if (engine === "webhook" && !url) return void (await record("not sent", "No BUG_WEBHOOK_URL configured"));
  const token = await getSetting("BUG_WEBHOOK_TOKEN");
  const payload = {
    event: "bug.logged",
    bugId: bug.bugId,
    title: bug.title,
    module: bug.module,
    severity: bug.severity,
    priority: bug.priority,
    status: bug.status,
    storyId: bug.story?.storyId ?? null,
    testCaseId: bug.testCase?.tcId ?? null,
    release: bug.release.name,
    environment: bug.environment,
    buildNo: bug.buildNo,
    browser: bug.browser,
    precondition: bug.precondition,
    steps: bug.steps,
    testData: bug.testData,
    expected: bug.expected,
    actual: bug.actual,
    evidenceUrl: bug.evidenceUrl,
    reproducedByHuman: bug.reproducedByHuman,
    workaround: bug.workaround,
    loggedAt: bug.loggedAt.toISOString(),
  };
  if (engine === "mcp") {
    const [mcpUrl, mcpToken, tool, argsJson] = await Promise.all([getSetting("BUG_MCP_URL"), getSetting("BUG_MCP_TOKEN"), getSetting("BUG_MCP_TOOL"), getSetting("BUG_MCP_ARGS")]);
    if (!mcpUrl || !tool) return void (await record("not sent", "MCP connector is not configured"));
    const description = [`Module: ${bug.module}`, bug.precondition && `Pre-condition: ${bug.precondition}`, `Steps:\n${bug.steps}`, bug.testData && `Test data: ${bug.testData}`, `Expected: ${bug.expected}`, `Actual: ${bug.actual}`, `Build: ${bug.buildNo} (${bug.environment})`, bug.evidenceUrl && `Evidence: ${bug.evidenceUrl}`].filter(Boolean).join("\n");
    try {
      const args = renderArgs(JSON.parse(argsJson || "{}"), { ...payload, description }) as Record<string, unknown>;
      await record("sent", (await mcpCallTool(mcpUrl, mcpToken, tool, args)) || "Tool returned no text");
    } catch (e) {
      await record("failed", e instanceof Error ? e.message : String(e));
    }
    return;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    const body = (await res.text()).slice(0, 500);
    await prisma.bug.update({ where: { id: bugId }, data: { webhookStatus: res.ok ? "sent" : "failed", webhookResponse: `${res.status} ${body}` } });
  } catch (e) {
    await prisma.bug.update({ where: { id: bugId }, data: { webhookStatus: "failed", webhookResponse: String(e).slice(0, 500) } });
  }
}
