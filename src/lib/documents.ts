const TEXT_EXT = new Set(["txt", "md", "csv", "tsv", "json", "html", "htm", "xml", "yaml", "yml"]);
export const ACCEPT = ".pdf,.docx,.xlsx,.txt,.md,.csv,.tsv,.json,.html,.htm,.xml,.yaml,.yml,.png,.jpg,.jpeg,.webp,.gif,.svg";
export const PROTOTYPE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", pdf: "application/pdf", html: "text/html", htm: "text/html", svg: "image/svg+xml" };
/** Pictures can only be prototype screens, whichever type was chosen. */
export const isPicture = (fileName: string) => /\.(png|jpe?g|webp|gif|svg)$/i.test(fileName);
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Characters of text per PDF page below which the pages are almost certainly scanned images. */
const MIN_PDF_CHARS_PER_PAGE = 20;

/** Pull plain text out of an uploaded file. Throws with a message the uploader can act on when nothing usable can be read. */
export async function extractText(fileName: string, buf: Buffer): Promise<string> {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  let text: string;
  if (ext === "pdf") text = await fromPdf(buf);
  else if (ext === "docx") text = (await (await import("mammoth")).default.extractRawText({ buffer: buf })).value;
  else if (ext === "xlsx") text = await fromXlsx(buf);
  else if (TEXT_EXT.has(ext)) text = buf.toString("utf8").replace(/^﻿/, "");
  else if (ext === "doc" || ext === "xls") throw new Error(`.${ext} is the old Office format. Save it as .${ext}x and upload again.`);
  else throw new Error(`.${ext || "unknown"} files cannot be read. Use PDF, DOCX, XLSX, CSV, TXT or MD.`);

  const clean = text.replace(/\u0000/g, "").trim();
  if (!clean) throw new Error("No text found in this file.");
  return clean;
}

async function fromPdf(buf: Buffer): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buf });
  try {
    const res = await parser.getText();
    const pages = res.total || 1;
    const chars = res.text.replace(/\s|--\s*\d+\s*of\s*\d+\s*--/g, "").length;
    if (chars / pages < MIN_PDF_CHARS_PER_PAGE) throw new Error(`This PDF has ${pages} pages but almost no text, so it looks scanned. Upload a text PDF or the source document.`);
    return res.text;
  } finally {
    await parser.destroy();
  }
}

async function fromXlsx(buf: Buffer): Promise<string> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const out: string[] = [];
  wb.eachSheet((sheet) => {
    out.push(`Sheet: ${sheet.name}`);
    sheet.eachRow((row) => {
      const cells: string[] = [];
      for (let c = 1; c <= row.cellCount; c++) cells.push(row.getCell(c).text.replace(/\s*\r?\n\s*/g, " ").trim());
      out.push(`| ${cells.join(" | ")} |`);
    });
  });
  return out.join("\n");
}
