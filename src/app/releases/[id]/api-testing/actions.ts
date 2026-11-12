"use server";

import { addEndpoints, saveTarget, startApiRun, startApiTests } from "@/lib/apitesting";
import { syncStages } from "@/lib/flows";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
/** Back to the page with a message. A declared function returning never, so TypeScript knows the code after it does not run. */
function back(releaseId: string, q: string): never {
  return redirect(`/releases/${releaseId}/api-testing?${q}`);
}
const err = (m: string) => `err=${encodeURIComponent(m)}`;
const ok = (m: string) => `ok=${encodeURIComponent(m)}`;
const info = (m: string) => `info=${encodeURIComponent(m)}`;

/** Where the API is and how to sign in to it. The header value is never shown again; a blank one keeps what is saved. */
export async function saveApiTarget(formData: FormData) {
  const releaseId = s(formData, "releaseId");
  const problem = await saveTarget(releaseId, { baseUrl: s(formData, "baseUrl"), authHeader: s(formData, "authHeader"), authValue: String(formData.get("authValue") ?? ""), vars: s(formData, "vars") });
  back(releaseId, problem ? err(problem) : ok("API address saved"));
}

/** The API list, pasted or uploaded: a plain list, a Postman collection or an OpenAPI document. */
export async function addApiList(formData: FormData) {
  const releaseId = s(formData, "releaseId");
  const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  const texts = [s(formData, "list"), ...(await Promise.all(files.map((f) => f.text())))].filter(Boolean);
  if (!texts.length) back(releaseId, err("Paste the API list or choose a file."));
  let added = 0, updated = 0, kind = "";
  for (const text of texts) {
    const r = await addEndpoints(releaseId, text);
    if ("error" in r) back(releaseId, err(r.error));
    added += r.added; updated += r.updated; kind = r.kind;
  }
  back(releaseId, ok(`${added} endpoint${added === 1 ? "" : "s"} added${updated ? `, ${updated} updated` : ""} from the ${kind}.`));
}

export async function removeEndpoint(formData: FormData) {
  const releaseId = s(formData, "releaseId"), id = s(formData, "endpoint");
  const e = await prisma.apiEndpoint.findUnique({ where: { id }, include: { tests: { select: { id: true } } } });
  if (!e || e.releaseId !== releaseId) back(releaseId, err("Endpoint not found."));
  await prisma.bugCandidate.deleteMany({ where: { releaseId, refKey: { in: e.tests.map((t) => `api:${t.id}`) }, status: "Pending" } });
  await prisma.apiEndpoint.delete({ where: { id } });
  await syncStages(releaseId);
  back(releaseId, ok(`${e.method} ${e.path} removed with its tests.`));
}

export async function clearEndpoints(formData: FormData) {
  const releaseId = s(formData, "releaseId");
  await prisma.bugCandidate.deleteMany({ where: { releaseId, source: "api", status: "Pending" } });
  const { count } = await prisma.apiEndpoint.deleteMany({ where: { releaseId } });
  await syncStages(releaseId);
  back(releaseId, ok(`${count} endpoints removed with their tests.`));
}

/** Claude writes the tests: for the endpoints without any, for all of them again, or for one. */
export async function writeApiTests(formData: FormData) {
  const releaseId = s(formData, "releaseId"), one = s(formData, "endpoint");
  const scope = one ? { endpointId: one } : s(formData, "scope") === "all" ? "all" : "missing";
  const problem = await startApiTests(releaseId, scope);
  back(releaseId, problem ? err(problem) : info("Writing the tests"));
}

/** Playwright sends the tests: all of them, the ones not passed, or one endpoint's. */
export async function runApiTests(formData: FormData) {
  const releaseId = s(formData, "releaseId"), one = s(formData, "endpoint");
  const scope = one ? { endpointId: one } : s(formData, "scope") === "failed" ? "failed" : "all";
  const problem = await startApiRun(releaseId, scope);
  back(releaseId, problem ? err(problem) : info("Run started"));
}

export async function removeApiTest(formData: FormData) {
  const releaseId = s(formData, "releaseId"), id = s(formData, "test");
  const t = await prisma.apiTest.findUnique({ where: { id }, select: { releaseId: true, testId: true } });
  if (!t || t.releaseId !== releaseId) back(releaseId, err("Test not found."));
  await prisma.bugCandidate.deleteMany({ where: { releaseId, refKey: `api:${id}`, status: "Pending" } });
  await prisma.apiTest.delete({ where: { id } });
  await syncStages(releaseId);
  back(releaseId, ok(`${t.testId} removed.`));
}
