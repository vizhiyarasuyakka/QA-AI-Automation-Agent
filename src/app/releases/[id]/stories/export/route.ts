import { defaultColumns, fillXlsxTemplate, TEST_DATA_COLUMNS, toCsv, toXlsx, type ExportRow, type TemplateColumn } from "@/lib/export";
import { prisma } from "@/lib/prisma";

const yes = (v: boolean) => (v ? "Yes" : "No");
const TYPES = { xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", csv: "text/csv; charset=utf-8" };

async function exportFile(release: { id: string; name: string }, format: string, only: { approved?: true; ids?: string[] }) {
  const id = release.id;
  const cases = await prisma.testCase.findMany({
    where: { story: { releaseId: id }, ...(only.approved ? { approved: true } : {}), ...(only.ids ? { id: { in: only.ids } } : {}) },
    include: { story: { select: { storyId: true } } },
    orderBy: [{ story: { storyId: "asc" } }, { tcId: "asc" }],
  });
  const rows: ExportRow[] = cases.map((c) => ({
    tcId: c.tcId, storyId: c.story.storyId, module: c.module, title: c.title, type: c.type, priority: c.priority, precondition: c.precondition, steps: c.steps, testData: c.testData, expected: c.expected,
    criteria: c.criteria, sourceRef: c.sourceRef, source: c.source, reviewed: yes(c.reviewed), approved: yes(c.approved), smoke: yes(c.smoke), regression: yes(c.regression), automated: yes(c.automated),
  }));

  const base = release.name.replace(/[^a-z0-9_-]+/gi, "_");
  const send = (body: Buffer, ext: "xlsx" | "csv", suffix = "test-cases") =>
    new Response(new Uint8Array(body), { headers: { "Content-Type": TYPES[ext], "Content-Disposition": `attachment; filename="${base}-${suffix}.${ext}"` } });

  if (format === "data-xlsx" || format === "data-csv") {
    const data = await prisma.testDataRow.findMany({ where: { story: { releaseId: id } }, include: { story: { select: { storyId: true, module: true } } }, orderBy: [{ story: { storyId: "asc" } }, { field: "asc" }] });
    const dataRows = data.map((r) => ({ storyId: r.story.storyId, module: r.story.module, field: r.field, kind: r.kind, value: r.value, purpose: r.purpose, tcIds: r.tcIds }));
    return format === "data-csv" ? send(toCsv(TEST_DATA_COLUMNS, dataRows), "csv", "test-data") : send(await toXlsx(TEST_DATA_COLUMNS, dataRows, "Test data"), "xlsx", "test-data");
  }
  if (format.startsWith("template:")) {
    const t = await prisma.exportTemplate.findUnique({ where: { id: format.slice("template:".length) } });
    if (!t) return new Response("Template not found", { status: 404 });
    const columns = JSON.parse(t.columns) as TemplateColumn[];
    const suffix = t.name.replace(/[^a-z0-9_-]+/gi, "_");
    if (t.format === "csv") return send(toCsv(columns, rows), "csv", suffix);
    return send(await fillXlsxTemplate(Buffer.from(t.bytes), t.sheetName, t.headerRow, columns, rows), "xlsx", suffix);
  }
  return format === "csv" ? send(toCsv(defaultColumns(), rows), "csv") : send(await toXlsx(defaultColumns(), rows), "xlsx");
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(req.url);
  const release = await prisma.release.findUnique({ where: { id } });
  if (!release) return new Response("Release not found", { status: 404 });
  return exportFile(release, url.searchParams.get("format") ?? "xlsx", url.searchParams.get("scope") === "approved" ? { approved: true } : {});
}

/** The ticked cases from the review page. A list that long does not fit in a URL, so this one posts. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const release = await prisma.release.findUnique({ where: { id } });
  if (!release) return new Response("Release not found", { status: 404 });
  const form = await req.formData();
  const ids = form.getAll("caseId").map(String);
  if (!ids.length) {
    const given = String(form.get("back") ?? "");
    const back = given.startsWith(`/releases/${id}/`) ? given : `/releases/${id}/review`;
    return Response.redirect(new URL(`${back}${back.includes("?") ? "&" : "?"}err=${encodeURIComponent("Tick at least one case to export")}`, req.url), 303);
  }
  return exportFile(release, String(form.get("format") ?? "xlsx"), { ids });
}
