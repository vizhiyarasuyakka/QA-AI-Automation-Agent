import { selectedEngine } from "./engines";
import { mcpCallTool, renderArgs } from "./mcp";
import { prisma } from "./prisma";
import { getSetting, pushBug } from "./webhook";
import { nextBugId } from "./workflow";

const latestBuild = (releaseId: string) => prisma.build.findFirst({ where: { releaseId }, orderBy: { deployedAt: "desc" } });

/** One draft per failed execution on the latest build. Running it again adds only new failures. */
export async function draftsFromFailedCases(releaseId: string): Promise<number> {
  const build = await latestBuild(releaseId);
  if (!build) return 0;
  const failed = await prisma.execution.findMany({ where: { buildId: build.id, result: "Fail" }, include: { testCase: { include: { story: true } } } });
  const existing = new Set((await prisma.bugCandidate.findMany({ where: { releaseId, source: "execution" }, select: { refKey: true } })).map((c) => c.refKey));
  let made = 0;
  for (const e of failed) {
    const refKey = `exec:${e.id}`;
    if (existing.has(refKey)) continue;
    const c = e.testCase;
    await prisma.bugCandidate.create({
      data: {
        releaseId, refKey, source: "execution", module: c.module, title: `${c.module}: ${c.title}`.slice(0, 80), severity: c.priority === "P1" ? "High" : c.priority === "P2" ? "Medium" : "Low",
        buildNo: build.number, storyRefId: c.storyId, testCaseRefId: c.id, precondition: c.precondition, steps: c.steps, testData: c.testData, expected: c.expected, actual: e.actual || e.notes || "Test case failed", evidenceUrl: e.evidenceUrl,
      },
    });
    made++;
  }
  return made;
}

/** Applies the same rules as the bug form: a person reproduces it first unless it is Low. */
export async function logCandidate(id: string, severity: string, reproducedByHuman: boolean): Promise<{ error?: string; message?: string }> {
  const d = await prisma.bugCandidate.findUnique({ where: { id } });
  if (!d || d.status !== "Pending") return { error: "This draft has already been handled." };
  if (!reproducedByHuman && severity !== "Low") return { error: "Reproduce the failure yourself and tick the box first. Only Low severity may be logged without reproduction." };
  const existing = await prisma.bug.findMany({ where: { releaseId: d.releaseId }, select: { bugId: true } });
  const bug = await prisma.bug.create({
    data: {
      releaseId: d.releaseId, bugId: nextBugId(existing.map((b) => b.bugId)), title: d.title, module: d.module, severity, priority: severity === "Critical" || severity === "High" ? "P1" : "P2",
      storyRefId: d.storyRefId, testCaseRefId: d.testCaseRefId, buildNo: d.buildNo, precondition: d.precondition, steps: d.steps, testData: d.testData, expected: d.expected, actual: d.actual,
      evidenceUrl: d.evidenceUrl && d.evidenceUrl.startsWith("/") ? `http://localhost:3100${d.evidenceUrl}` : d.evidenceUrl, reproducedByHuman,
    },
  });
  await prisma.bugCandidate.update({ where: { id }, data: { status: "Logged", bugRefId: bug.id, severity } });
  await pushBug(bug.id);
  const pushed = await prisma.bug.findUnique({ where: { id: bug.id } });
  return { message: `${bug.bugId} logged. Sent: ${pushed?.webhookStatus}. ${(pushed?.webhookResponse ?? "").slice(0, 100)}` };
}

export async function sendReport(releaseId: string): Promise<{ error?: string; message?: string }> {
  if ((await selectedEngine("bugs")) !== "mcp") return { error: "Choose the MCP connector for bug logging first." };
  const [url, token, tool, argsJson] = await Promise.all([getSetting("BUG_MCP_URL"), getSetting("BUG_MCP_TOKEN"), getSetting("REPORT_MCP_TOOL"), getSetting("REPORT_MCP_ARGS")]);
  if (!url || !tool) return { error: "Choose the report tool in Settings first." };
  const [release, build] = await Promise.all([prisma.release.findUnique({ where: { id: releaseId } }), latestBuild(releaseId)]);
  if (!release || !build) return { error: "Enter the URL to test in step 4 first." };
  const execs = await prisma.execution.findMany({ where: { buildId: build.id }, include: { testCase: { include: { story: true } } }, orderBy: { testCase: { tcId: "asc" } } });
  if (!execs.length) return { error: "This build has no planned test cases." };
  const count = (r: string) => execs.filter((e) => e.result === r).length;
  const passed = count("Pass"), failed = count("Fail"), blocked = count("Blocked"), notRun = count("Not run");
  const executed = passed + failed;
  const failedCases = execs.filter((e) => e.result === "Fail").map((e) => `${e.testCase.tcId} ${e.testCase.title}${e.actual ? `: ${e.actual}` : ""}`).join("\n");
  const values = {
    release: release.name, build: build.number, total: execs.length, passed, failed, blocked, notRun,
    passRate: executed ? `${Math.round((passed / executed) * 100)}%` : "0%",
    summary: `${release.name}, build ${build.number}: ${passed} passed, ${failed} failed, ${blocked} blocked, ${notRun} not run, of ${execs.length} cases.${failedCases ? `\n\nFailed:\n${failedCases}` : ""}`,
    failedCases,
    results: execs.map((e) => ({ tcId: e.testCase.tcId, storyId: e.testCase.story.storyId, title: e.testCase.title, priority: e.testCase.priority, result: e.result, executedBy: e.executedBy, actual: e.actual })),
    sentAt: new Date().toISOString(),
  };
  const counts = { releaseId, buildNo: build.number, total: execs.length, passed, failed, blocked, notRun };
  try {
    const args = renderArgs(JSON.parse(argsJson || "{}"), values) as Record<string, unknown>;
    const response = await mcpCallTool(url, token, tool, args);
    await prisma.reportPush.create({ data: { ...counts, status: "sent", response: response.slice(0, 500) } });
    return { message: `Report sent: ${passed} passed, ${failed} failed. ${response.slice(0, 100)}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await prisma.reportPush.create({ data: { ...counts, status: "failed", response: msg.slice(0, 500) } });
    return { error: `Report not sent: ${msg.slice(0, 200)}` };
  }
}
