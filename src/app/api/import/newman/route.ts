import { prisma } from "@/lib/prisma";
import { applyToBuild, authorize, resolveRelease } from "../_shared";

export const dynamic = "force-dynamic";

/** Accepts Newman JSON reporter output: newman run collection.json -r json --reporter-json-export results.json */
export async function POST(req: Request) {
  const denied = await authorize(req); if (denied) return denied;
  const { release, error } = await resolveRelease(req);
  if (!release) return error;
  const buildNo = req.headers.get("x-build");
  if (buildNo && !(await prisma.build.findUnique({ where: { releaseId_number: { releaseId: release.id, number: buildNo } } }))) return Response.json({ error: `Build ${buildNo} is not registered on ${release.name}` }, { status: 404 });
  const body = await req.json().catch(() => null);
  const execs = body?.run?.executions;
  if (!Array.isArray(execs)) return Response.json({ error: "expected Newman JSON export (run.executions)" }, { status: 400 });
  const results = execs.map((e: { item?: { name?: string }; requestError?: unknown; assertions?: { error?: unknown }[] }) => {
    const failed = !!e.requestError || (e.assertions ?? []).some((a) => a.error);
    return { title: e.item?.name ?? "request", status: (failed ? "failed" : "passed") as "passed" | "failed" };
  });
  const passed = results.filter((r) => r.status === "passed").length;
  const run = await prisma.automationRun.create({ data: { releaseId: release.id, source: "newman", runLabel: req.headers.get("x-run-label") ?? "", passed, failed: results.length - passed, total: results.length, durationSec: Math.round((body.run?.timings?.completed - body.run?.timings?.started || 0) / 1000) } });
  const mapped = await applyToBuild(release.id, req.headers.get("x-build"), results);
  return Response.json({ ok: true, runId: run.id, total: results.length, passed, failed: results.length - passed, executionsUpdated: mapped });
}
