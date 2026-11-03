"use server";

import { prisma } from "@/lib/prisma";
import { parsePastedCases } from "@/lib/claude";
import { normalizeCriteria } from "@/lib/coverage";
import { syncStages } from "@/lib/flows";
import { guessColumns, readTemplate, type TemplateColumn } from "@/lib/export";
import { nextCaseId, startGeneration, startStoryReading } from "@/lib/generation";
import { MAX_CASE_PROMPT_CHARS, saveCasePrompt } from "@/lib/prompts";
import { planCases } from "@/lib/testurl";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
/** Forms on the review page send `back` so the person stays on the story being reviewed. */
const to = (back: string, kind: "ok" | "err", message: string) => `${back}${back.includes("?") ? "&" : "?"}${kind}=${encodeURIComponent(message)}`;

export async function createStory(formData: FormData) {
  const releaseId = s(formData, "releaseId");
  const storyId = s(formData, "storyId");
  const title = s(formData, "title");
  const module = s(formData, "module");
  if (!storyId || !title || !module) redirect(`/releases/${releaseId}/stories?err=Story ID, title and module are required`);
  const exists = await prisma.story.findUnique({ where: { releaseId_storyId: { releaseId, storyId } } });
  if (exists) redirect(`/releases/${releaseId}/stories?err=${encodeURIComponent(`${storyId} already exists in this release`)}`);
  const story = await prisma.story.create({ data: { releaseId, storyId, title, module } });
  redirect(`/releases/${releaseId}/stories/${story.id}?info=Fill intake, then generate or paste test cases.`);
}

export async function updateStoryIntake(formData: FormData) {
  const id = s(formData, "id");
  const releaseId = s(formData, "releaseId");
  const acceptanceCriteria = normalizeCriteria(s(formData, "acceptanceCriteria"));
  await prisma.story.update({
    where: { id },
    data: {
      title: s(formData, "title"), module: s(formData, "module"),
      userStory: s(formData, "userStory"), acceptanceCriteria,
      fieldDoc: s(formData, "fieldDoc"), prototypeNotes: s(formData, "prototypeNotes"),
      clarificationLog: s(formData, "clarificationLog"),
    },
  });
  revalidatePath(`/releases/${releaseId}/stories/${id}`);
  await syncStages(releaseId);
  redirect(`/releases/${releaseId}/stories/${id}?ok=Intake saved`);
}

/** The stories ticked in the picker, with their cases and test data. Only stories of this release can go. */
export async function deleteStories(formData: FormData) {
  const releaseId = s(formData, "releaseId");
  const back = `/releases/${releaseId}/stories`;
  const ids = formData.getAll("story").map(String);
  if (!ids.length) redirect(`${back}?err=${encodeURIComponent("Select at least one story to delete")}`);
  const where = { releaseId, id: { in: ids } };
  const cases = await prisma.testCase.count({ where: { story: where } });
  const { count } = await prisma.story.deleteMany({ where });
  await syncStages(releaseId);
  redirect(`${back}?ok=${encodeURIComponent(`${count} ${count === 1 ? "story" : "stories"} and ${cases} test ${cases === 1 ? "case" : "cases"} deleted`)}`);
}

export async function generateCases(formData: FormData) {
  const id = s(formData, "id"); const releaseId = s(formData, "releaseId");
  const err = await startGeneration(releaseId, id);
  if (err) redirect(`/releases/${releaseId}/stories/${id}?err=${encodeURIComponent(err)}`);
  redirect(`/releases/${releaseId}/stories/${id}?info=${encodeURIComponent("Generation started")}`);
}

export async function triggerGeneration(formData: FormData) {
  const releaseId = s(formData, "releaseId");
  const err = await startGeneration(releaseId, undefined, formData.getAll("story").map(String), formData.getAll("prd").map(String));
  const back = `/releases/${releaseId}/stories`;
  if (err) redirect(`${back}?err=${encodeURIComponent(err)}`);
  redirect(`${back}?info=${encodeURIComponent("Generation started")}`);
}

export async function updateCasePrompt(formData: FormData) {
  const back = `/releases/${s(formData, "releaseId")}/stories`;
  if (formData.get("reset") !== null) {
    await saveCasePrompt("");
    redirect(`${back}?ok=${encodeURIComponent("Test case prompt reset to the default")}`);
  }
  const prompt = s(formData, "prompt");
  if (prompt.length > MAX_CASE_PROMPT_CHARS) redirect(`${back}?err=${encodeURIComponent(`The prompt is too long. Keep it under ${MAX_CASE_PROMPT_CHARS.toLocaleString("en-IN")} characters.`)}`);
  await saveCasePrompt(prompt);
  redirect(`${back}?ok=${encodeURIComponent("Test case prompt saved. The next generation uses it.")}`);
}

export async function triggerStoryReading(formData: FormData) {
  const releaseId = s(formData, "releaseId");
  const err = await startStoryReading(releaseId);
  const back = `/releases/${releaseId}/stories`;
  if (err) redirect(`${back}?err=${encodeURIComponent(err)}`);
  redirect(`${back}?info=${encodeURIComponent("Loading the user stories")}`);
}

export async function uploadTemplate(formData: FormData) {
  const back = `/releases/${s(formData, "releaseId")}/review`;
  const file = formData.get("file");
  if (!(file instanceof File) || !file.size) redirect(`${back}?err=Choose a template file`);
  const bytes = Buffer.from(await file.arrayBuffer());
  let info: Awaited<ReturnType<typeof readTemplate>>;
  try {
    info = await readTemplate(file.name, bytes);
  } catch (e) {
    redirect(`${back}?err=${encodeURIComponent(e instanceof Error ? e.message : String(e))}`);
  }
  const columns = guessColumns(info.headers);
  await prisma.exportTemplate.create({ data: { name: s(formData, "name") || file.name.replace(/\.\w+$/, ""), fileName: file.name, format: info.format, bytes, sheetName: info.sheetName, headerRow: info.headerRow, columns: JSON.stringify(columns) } });
  const unmatched = columns.filter((c) => !c.field && c.header).length;
  redirect(`${back}?ok=${encodeURIComponent(`Template saved with ${columns.length} columns${unmatched ? `; ${unmatched} need matching below` : ""}`)}`);
}

export async function saveTemplateColumns(formData: FormData) {
  const id = s(formData, "id"); const back = `/releases/${s(formData, "releaseId")}/review`;
  const t = await prisma.exportTemplate.findUnique({ where: { id } });
  if (!t) redirect(`${back}?err=Template not found`);
  const columns = (JSON.parse(t.columns) as TemplateColumn[]).map((c, i) => ({ header: c.header, field: s(formData, `col${i}`) as TemplateColumn["field"] }));
  await prisma.exportTemplate.update({ where: { id }, data: { columns: JSON.stringify(columns) } });
  redirect(`${back}?ok=Template columns saved`);
}

export async function deleteTemplate(formData: FormData) {
  await prisma.exportTemplate.delete({ where: { id: s(formData, "id") } });
  redirect(`/releases/${s(formData, "releaseId")}/review?ok=Template removed`);
}

export async function importPastedCases(formData: FormData) {
  const id = s(formData, "id"); const releaseId = s(formData, "releaseId");
  const text = String(formData.get("pasted") ?? "");
  const cases = parsePastedCases(text);
  if (!cases.length) redirect(`/releases/${releaseId}/stories/${id}?err=No rows parsed. Paste a pipe table with a header row containing TC ID, Title, Type, Priority, Steps, Expected.`);
  const story = await prisma.story.findUnique({ where: { id } });
  for (const c of cases) {
    await prisma.testCase.upsert({
      where: { storyId_tcId: { storyId: id, tcId: c.tcId } },
      update: { module: c.module || story?.module || "", title: c.title, type: c.type, priority: c.priority, precondition: c.precondition, steps: c.steps, testData: c.testData, expected: c.expected, criteria: c.criteria, covers: "[]", source: "import", reviewed: false, approved: false },
      create: { storyId: id, tcId: c.tcId, module: c.module || story?.module || "", title: c.title, type: c.type, priority: c.priority, precondition: c.precondition, steps: c.steps, testData: c.testData, expected: c.expected, criteria: c.criteria, source: "import" },
    });
  }
  await planCases(releaseId);
  await syncStages(releaseId);
  redirect(`/releases/${releaseId}/stories/${id}?ok=${encodeURIComponent(`${cases.length} cases imported`)}`);
}

/** A case typed by a person, from step 2 or the story page. A blank TC ID takes the story's next number. */
export async function addCase(formData: FormData) {
  const id = s(formData, "id"); const releaseId = s(formData, "releaseId");
  const given = s(formData, "back");
  const back = given.startsWith(`/releases/${releaseId}/`) ? given : `/releases/${releaseId}/stories/${id}`;
  const story = await prisma.story.findUnique({ where: { id }, include: { testCases: { select: { tcId: true } } } });
  if (!story || story.releaseId !== releaseId) redirect(to(back, "err", "Choose a user story of this release"));
  const title = s(formData, "title");
  if (!title) redirect(to(back, "err", "A title is required"));
  const tcId = s(formData, "tcId") || nextCaseId(story, story.testCases.map((t) => t.tcId));
  const criteria = s(formData, "criteria").split(/[,\s]+/).filter(Boolean).map((c) => c.toUpperCase()).join(",");
  const fields = { title, type: s(formData, "type") || "Positive", priority: s(formData, "priority") || "P2", precondition: s(formData, "precondition"), steps: s(formData, "steps"), testData: s(formData, "testData"), expected: s(formData, "expected"), criteria, module: s(formData, "module") || story.module };
  await prisma.testCase.upsert({
    where: { storyId_tcId: { storyId: id, tcId } },
    update: { ...fields, covers: "[]", reviewed: false, approved: false },
    create: { storyId: id, tcId, ...fields, source: "manual" },
  });
  await planCases(releaseId);
  await syncStages(releaseId);
  redirect(to(back, "ok", `${tcId} saved`));
}

export async function updateCaseFlags(formData: FormData) {
  const id = s(formData, "id"); const releaseId = s(formData, "releaseId"); const storyId = s(formData, "storyId");
  await prisma.testCase.update({
    where: { id },
    data: {
      reviewed: formData.get("reviewed") === "on",
      smoke: formData.get("smoke") === "on", regression: formData.get("regression") === "on", automated: formData.get("automated") === "on",
      priority: s(formData, "priority"), criteria: s(formData, "criteria"),
    },
  });
  revalidatePath(`/releases/${releaseId}/stories/${storyId}`);
}

export async function bulkCaseAction(formData: FormData) {
  const releaseId = s(formData, "releaseId"); const storyId = s(formData, "storyId"); const action = s(formData, "action");
  const ids = formData.getAll("caseId").map(String);
  const back = s(formData, "back") || `/releases/${releaseId}/stories/${storyId}`;
  if (!ids.length) redirect(to(back, "err", "Select at least one case"));
  const data: { reviewed?: boolean; approved?: boolean; smoke?: boolean; regression?: boolean } = action === "review" ? { reviewed: true } : action === "approve" ? { reviewed: true, approved: true } : action === "smoke" ? { smoke: true } : action === "regression" ? { regression: true } : action === "reject" ? { approved: false } : {};
  if (action === "delete") await prisma.testCase.deleteMany({ where: { id: { in: ids } } });
  else await prisma.testCase.updateMany({ where: { id: { in: ids } }, data });
  await syncStages(releaseId);
  redirect(to(back, "ok", `${ids.length} cases ${action === "delete" ? "deleted" : "updated"}`));
}

export async function deleteCase(formData: FormData) {
  const id = s(formData, "id"); const releaseId = s(formData, "releaseId"); const storyId = s(formData, "storyId");
  await prisma.testCase.delete({ where: { id } });
  await syncStages(releaseId);
  redirect(`/releases/${releaseId}/stories/${storyId}?ok=Case deleted`);
}

export async function saveCoverageRow(formData: FormData) {
  const storyId = s(formData, "storyId"); const releaseId = s(formData, "releaseId");
  const field = s(formData, "field");
  if (!field) redirect(`/releases/${releaseId}/stories/${storyId}?err=Field name is required`);
  await prisma.coverageRow.create({ data: { storyId, field, mandatory: s(formData, "mandatory"), minMax: s(formData, "minMax"), format: s(formData, "format"), defaultV: s(formData, "defaultV"), dropdown: s(formData, "dropdown"), tcIds: s(formData, "tcIds") } });
  redirect(`/releases/${releaseId}/stories/${storyId}?ok=Coverage row added`);
}

export async function deleteCoverageRow(formData: FormData) {
  const id = s(formData, "id"); const storyId = s(formData, "storyId"); const releaseId = s(formData, "releaseId");
  await prisma.coverageRow.delete({ where: { id } });
  revalidatePath(`/releases/${releaseId}/stories/${storyId}`);
}
