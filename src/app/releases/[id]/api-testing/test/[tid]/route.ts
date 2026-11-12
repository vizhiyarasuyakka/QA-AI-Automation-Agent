import { prisma } from "@/lib/prisma";
import { endpointLabel } from "@/lib/apitesting";

export const dynamic = "force-dynamic";

/** One API test's evidence as plain text: what it expected, what was sent and what came back. Bug drafts link here. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; tid: string }> }) {
  const { id, tid } = await params;
  const t = await prisma.apiTest.findUnique({ where: { id: tid }, include: { endpoint: true } });
  if (!t || t.releaseId !== id) return new Response("Test not found", { status: 404 });
  const text = [
    `${t.testId} ${t.title}`,
    `${endpointLabel(t.endpoint)} | ${t.kind} test | ${t.result}${t.runAt ? ` on ${t.runAt.toISOString()}` : ""}${t.buildNo ? ` | build ${t.buildNo}` : ""}`,
    `Expected: status ${t.expectStatus}${t.maxMs ? `, within ${t.maxMs} ms` : ""}`,
    `Checks: ${t.checks}`,
    `What happened: ${t.actual || "(not sent yet)"}`,
    "",
    "--- Request (sign-in header hidden) ---",
    t.request || "(not sent yet)",
    "",
    "--- Reply ---",
    t.response || "(none)",
    "",
  ].join("\n");
  return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
