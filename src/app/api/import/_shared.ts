import { prisma } from "@/lib/prisma";
import { getSetting } from "@/lib/webhook";

export async function authorize(req: Request): Promise<Response | null> {
  const expected = await getSetting("IMPORT_TOKEN");
  if (expected && req.headers.get("x-import-token") !== expected) return Response.json({ error: "invalid X-Import-Token" }, { status: 401 });
  return null;
}

/** Finds the target by X-Release-Id, or by X-Release when that name is unique. A repeated name is refused, never guessed. */
export async function resolveRelease(req: Request) {
  const id = req.headers.get("x-release-id");
  if (id) {
    const release = await prisma.release.findUnique({ where: { id } });
    return release ? { release } : { error: Response.json({ error: "No release has that X-Release-Id" }, { status: 404 }) };
  }
  const name = req.headers.get("x-release") ?? new URL(req.url).searchParams.get("release");
  if (!name) return { error: Response.json({ error: "X-Release header (release name) or X-Release-Id is required" }, { status: 400 }) };
  const matches = await prisma.release.findMany({ where: { name }, select: { id: true } });
  if (!matches.length) return { error: Response.json({ error: `No release is named ${name}` }, { status: 404 }) };
  if (matches.length > 1) return { error: Response.json({ error: `${matches.length} releases are named ${name}. Send X-Release-Id instead.`, releaseIds: matches.map((m) => m.id) }, { status: 409 }) };
  return { release: await prisma.release.findUniqueOrThrow({ where: { id: matches[0].id } }) };
}

type PwResult = { status?: string; error?: { message?: string } };
type PwSpec = { title: string; tests?: { status: string; results?: PwResult[] }[] };
type PwSuite = { title: string; specs?: PwSpec[]; suites?: PwSuite[] };
export type PwOutcome = { title: string; status: "passed" | "failed" | "skipped" | "flaky"; error?: string };

/** First line of an error message, without terminal colours. */
export const firstLine = (message: string) => message.replace(/\u001b\[[0-9;]*m/g, "").split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 300) ?? "";

/** One entry per spec of the Playwright JSON reporter output, titled with its suites, with the first line of its first error. */
export function flattenPlaywright(report: { suites?: PwSuite[] }): PwOutcome[] {
  const out: PwOutcome[] = [];
  const walk = (s: PwSuite, prefix: string) => {
    for (const spec of s.specs ?? []) {
      // One entry per browser project: a failure in any of them fails the spec.
      const all = (spec.tests ?? []).map((t) => t.status);
      const status = all.includes("unexpected") ? "failed" : all.includes("flaky") ? "flaky" : all.includes("expected") ? "passed" : "skipped";
      const message = (spec.tests ?? []).flatMap((t) => t.results ?? []).map((r) => r.error?.message).find(Boolean);
      const error = message ? firstLine(message) : "";
      out.push({ title: `${prefix}${spec.title}`, status, ...(error ? { error } : {}) });
    }
    for (const sub of s.suites ?? []) walk(sub, `${prefix}${sub.title} > `);
  };
  for (const s of report.suites ?? []) walk(s, `${s.title} > `);
  return out;
}

/** A TC ID counts only as a whole token, so A-1 never matches a test titled A-10. */
const mentions = (title: string, tcId: string) => new RegExp(`(^|[^A-Za-z0-9-])${tcId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9-])`).test(title);

/** Map a spec title to a planned execution on the build via a TC ID mentioned in the title (e.g. "PAY-VR-203-004 submits payment"). */
export async function applyToBuild(releaseId: string, buildNo: string | null, results: { title: string; status: "passed" | "failed" | "skipped" | "flaky" }[]) {
  if (!buildNo) return 0;
  const build = await prisma.build.findUnique({ where: { releaseId_number: { releaseId, number: buildNo } } });
  if (!build) return 0;
  const execs = await prisma.execution.findMany({ where: { buildId: build.id }, include: { testCase: true } });
  let n = 0;
  for (const r of results) {
    const hit = execs.find((e) => mentions(r.title, e.testCase.tcId));
    if (!hit) continue;
    const result = r.status === "passed" || r.status === "flaky" ? "Pass" : r.status === "failed" ? "Fail" : "Blocked";
    await prisma.execution.update({ where: { id: hit.id }, data: { result, executedBy: "AI", humanVerified: false, lane: hit.lane === "API" ? "API" : "UI", notes: `CI ${r.status}: ${r.title}`.slice(0, 500), executedAt: new Date() } });
    if (!hit.testCase.automated && (r.status === "passed" || r.status === "flaky")) await prisma.testCase.update({ where: { id: hit.testCase.id }, data: { automated: true } });
    n++;
  }
  return n;
}
