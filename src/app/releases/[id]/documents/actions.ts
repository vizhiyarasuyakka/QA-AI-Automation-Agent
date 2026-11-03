"use server";

import { prisma } from "@/lib/prisma";
import { extractText, isPicture, MAX_FILE_BYTES, PROTOTYPE_TYPES } from "@/lib/documents";
import { syncStages } from "@/lib/flows";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

export async function uploadDocuments(formData: FormData) {
  const releaseId = s(formData, "releaseId");
  const docType = s(formData, "docType") || "PRD";
  const module = s(formData, "module");
  const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  const back = `/releases/${releaseId}/documents`;
  if (!files.length) redirect(`${back}?err=Choose at least one file`);

  let ok = 0;
  const failed: string[] = [];
  for (const f of files) {
    const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
    if (docType === "Prototype" || isPicture(f.name)) {
      if (!PROTOTYPE_TYPES[ext] || f.size > MAX_FILE_BYTES) {
        failed.push(f.name);
        continue;
      }
      const old = await prisma.prototype.findFirst({ where: { releaseId, fileName: f.name, module }, select: { pagePath: true } });
      await prisma.prototype.deleteMany({ where: { releaseId, fileName: f.name, module } });
      await prisma.prototype.create({ data: { releaseId, module, pagePath: old?.pagePath ?? "", screen: f.name.replace(/\.\w+$/, ""), fileName: f.name, mimeType: PROTOTYPE_TYPES[ext], bytes: Buffer.from(await f.arrayBuffer()), sizeBytes: f.size } });
      ok++;
      continue;
    }
    let text = "", error = "";
    try {
      if (f.size > MAX_FILE_BYTES) throw new Error(`Larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
      text = await extractText(f.name, Buffer.from(await f.arrayBuffer()));
      ok++;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      failed.push(f.name);
    }
    const data = { docType, sizeBytes: f.size, text, status: error ? "Failed" : "Ready", error, uploadedAt: new Date() };
    await prisma.document.upsert({ where: { releaseId_fileName_module: { releaseId, fileName: f.name, module } }, update: data, create: { releaseId, fileName: f.name, module, ...data } });
  }
  await syncStages(releaseId);
  if (failed.length) redirect(`${back}?err=${encodeURIComponent(`${ok} saved, but could not read: ${failed.join(", ")}. See the list below. Prototypes can be PNG, JPG, WEBP, GIF, SVG, PDF or HTML up to ${MAX_FILE_BYTES / 1024 / 1024} MB.`)}`);
  redirect(`${back}?ok=${encodeURIComponent(`${ok} file${ok === 1 ? "" : "s"} saved`)}`);
}

export async function deleteDocument(formData: FormData) {
  const id = s(formData, "id"); const releaseId = s(formData, "releaseId");
  if (s(formData, "kind") === "prototype") await prisma.prototype.delete({ where: { id } });
  else await prisma.document.delete({ where: { id } });
  await syncStages(releaseId);
  revalidatePath(`/releases/${releaseId}/documents`);
  redirect(`/releases/${releaseId}/documents?ok=File removed`);
}
