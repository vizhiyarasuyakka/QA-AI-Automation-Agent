export const CASE_FIELDS = ["tcId", "storyId", "module", "title", "type", "priority", "precondition", "steps", "testData", "expected", "criteria", "sourceRef", "source", "reviewed", "approved", "smoke", "regression", "automated"] as const;
export type CaseField = (typeof CASE_FIELDS)[number];
export type ExportRow = Record<CaseField, string>;
export type TemplateColumn = { header: string; field: CaseField | "" };

export const FIELD_LABELS: Record<CaseField, string> = {
  tcId: "TC ID", storyId: "Story ID", module: "Module", title: "Title", type: "Type", priority: "Priority", precondition: "Pre-condition", steps: "Steps", testData: "Test data", expected: "Expected result",
  criteria: "Criteria covered", sourceRef: "Source", source: "Created by", reviewed: "Reviewed", approved: "Approved", smoke: "Smoke", regression: "Regression", automated: "Automated",
};

const HEADER_HINTS: [RegExp, CaseField][] = [
  [/^(tc|test ?case|test|case)[ _-]*(id|no|number|#)|^id$|^s\.?no$/i, "tcId"],
  [/(story|requirement|req)[ _-]*(id|no|ref)?/i, "storyId"],
  [/module|feature|component|area/i, "module"],
  [/title|summary|scenario|test ?case ?(name|description)?$|description/i, "title"],
  [/priority/i, "priority"],
  [/type|category/i, "type"],
  [/pre[ -]?(condition|req)/i, "precondition"],
  [/step/i, "steps"],
  [/data/i, "testData"],
  [/expected/i, "expected"],
  [/criteria|^ac$/i, "criteria"],
  [/source|reference/i, "sourceRef"],
  [/smoke/i, "smoke"],
  [/regression/i, "regression"],
  [/automat/i, "automated"],
  [/approved/i, "approved"],
  [/reviewed/i, "reviewed"],
];

export function guessColumns(headers: string[]): TemplateColumn[] {
  const taken = new Set<CaseField>();
  return headers.map((header) => {
    const hit = HEADER_HINTS.find(([re, f]) => !taken.has(f) && re.test(header.trim()));
    if (hit) taken.add(hit[1]);
    return { header, field: hit ? hit[1] : "" };
  });
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Find the column headers: the first row with at least two filled cells, which skips any title rows above them. */
export async function readTemplate(fileName: string, buf: Buffer): Promise<{ format: "xlsx" | "csv"; sheetName: string; headerRow: number; headers: string[] }> {
  const ext = fileName.split(".").pop()?.toLowerCase();
  if (ext === "csv") {
    const lines = buf.toString("utf8").replace(/^﻿/, "").split(/\r?\n/);
    const idx = lines.findIndex((l) => parseCsvLine(l).filter((c) => c.trim()).length >= 2);
    if (idx < 0) throw new Error("No header row found in this CSV.");
    return { format: "csv", sheetName: "", headerRow: idx + 1, headers: parseCsvLine(lines[idx]).map((h) => h.trim()) };
  }
  if (ext !== "xlsx") throw new Error("Upload the template as .xlsx or .csv.");
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  for (const sheet of wb.worksheets) {
    for (let r = 1; r <= Math.min(sheet.rowCount, 30); r++) {
      const row = sheet.getRow(r);
      const headers: string[] = [];
      for (let c = 1; c <= row.cellCount; c++) headers.push(row.getCell(c).text.trim());
      if (headers.filter(Boolean).length >= 2) return { format: "xlsx", sheetName: sheet.name, headerRow: r, headers };
    }
  }
  throw new Error("No header row found in this workbook.");
}

/** Spreadsheet apps run a cell starting with one of these as a formula, and this text comes from documents and a model. */
const safeCsv = (v: string) => `"${(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`;

type AnyColumn = { header: string; field: string };
type AnyRow = Record<string, string>;

export function toCsv(columns: AnyColumn[], rows: AnyRow[]): Buffer {
  const lines = [columns.map((c) => safeCsv(c.header)).join(","), ...rows.map((r) => columns.map((c) => safeCsv(c.field ? r[c.field] : "")).join(","))];
  return Buffer.from(`﻿${lines.join("\r\n")}\r\n`, "utf8");
}

export async function toXlsx(columns: AnyColumn[], rows: AnyRow[], sheet = "Test cases"): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  ws.columns = columns.map((c) => ({ header: c.header, width: c.field === "steps" || c.field === "expected" ? 50 : c.field === "title" ? 40 : 16 }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  for (const r of rows) ws.addRow(columns.map((c) => (c.field ? r[c.field] : ""))).alignment = { wrapText: true, vertical: "top" };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Write rows under the template's own headers, keeping its title rows, widths and styling. */
export async function fillXlsxTemplate(bytes: Buffer, sheetName: string, headerRow: number, columns: TemplateColumn[], rows: ExportRow[]): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  const ws = wb.getWorksheet(sheetName) ?? wb.worksheets[0];
  const sample = ws.getRow(headerRow + 1);
  const styles = columns.map((_, i) => ({ ...sample.getCell(i + 1).style }));
  if (ws.rowCount > headerRow) ws.spliceRows(headerRow + 1, ws.rowCount - headerRow);
  rows.forEach((r, i) => {
    const row = ws.getRow(headerRow + 1 + i);
    columns.forEach((c, j) => {
      const cell = row.getCell(j + 1);
      cell.value = c.field ? r[c.field] : "";
      cell.style = { ...styles[j], alignment: { wrapText: true, vertical: "top", ...styles[j].alignment } };
    });
    row.commit();
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export const TEST_DATA_COLUMNS: AnyColumn[] = [["Story ID", "storyId"], ["Module", "module"], ["Field", "field"], ["Kind", "kind"], ["Value", "value"], ["Purpose", "purpose"], ["Used by", "tcIds"]].map(([header, field]) => ({ header, field }));

// Approval is not used any more, so the default sheet leaves it out; a template can still ask for it.
export const defaultColumns = (): TemplateColumn[] => CASE_FIELDS.filter((f) => f !== "approved").map((f) => ({ header: FIELD_LABELS[f], field: f }));
