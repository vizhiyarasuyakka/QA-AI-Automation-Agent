import { prisma } from "@/lib/prisma";
import { applyToBuild, authorize, flattenPlaywright, resolveRelease } from "../_shared";

export const dynamic = "force-dynamic";

/** Accepts the Playwright JSON reporter output: npx playwright test --reporter=json > results.json */
export async function POST(req: Request) {
  const denied = await authorize(req); if (denied) return denied;
  const { release, error } = await resolveRelease(req);
  if (!release) return error;
  const buildNo = req.headers.get("x-build");
  if (buildNo && !(await prisma.build.findUnique({ where: { releaseId_number: { releaseId: release.id, number: buildNo } } }))) return Response.json({ error: `Build ${buildNo} is not registered on ${release.name}` }, { status: 404 });
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.suites)) return Response.json({ error: "expected Playwright JSON reporter output" }, { status: 400 });
  const results = flattenPlaywright(body);
  const count = (st: string) => results.filter((r) => r.status === st).length;
  const run = await prisma.automationRun.create({
    data: { releaseId: release.id, source: "playwright", runLabel: req.headers.get("x-run-label") ?? "", passed: count("passed"), failed: count("failed"), flaky: count("flaky"), skipped: count("skipped"), total: results.length, durationSec: Math.round((body.stats?.duration ?? 0) / 1000) },
  });
  const mapped = await applyToBuild(release.id, req.headers.get("x-build"), results);
  return Response.json({ ok: true, runId: run.id, total: results.length, passed: run.passed, failed: run.failed, flaky: run.flaky, skipped: run.skipped, executionsUpdated: mapped });
}
