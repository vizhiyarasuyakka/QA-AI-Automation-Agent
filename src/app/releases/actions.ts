"use server";

import { audit, requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ensureStages } from "@/lib/workflow";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

const STATUSES = ["Active", "Signed off", "Released", "Closed"];

export async function createRelease(formData: FormData) {
  const user = await requireRole("QA Lead", "create releases");
  const name = String(formData.get("name") ?? "").trim();
  if (!name) redirect("/releases?err=Release name is required");
  if (await prisma.release.findFirst({ where: { name } })) redirect(`/releases?err=${encodeURIComponent(`A release named ${name} already exists. CI results find a release by name, so names must be unique.`)}`);
  const r = await prisma.release.create({ data: { name } });
  await ensureStages(r.id);
  await audit(user, "release.create", { releaseId: r.id, target: name });
  redirect(`/releases/${r.id}/documents?info=${encodeURIComponent("Upload the PRD, user stories and field documents to begin.")}`);
}

export async function deleteRelease(formData: FormData) {
  const user = await requireRole("QA Lead", "delete releases");
  const id = String(formData.get("id"));
  const release = await prisma.release.delete({ where: { id } });
  await audit(user, "release.delete", { target: release.name, detail: `release ${id} and everything in it` });
  revalidatePath("/releases");
  redirect("/releases?ok=Release deleted");
}

export async function setReleaseStatus(formData: FormData) {
  const user = await requireRole("QA Lead", "change the release status");
  const id = String(formData.get("id"));
  const status = String(formData.get("status"));
  if (!STATUSES.includes(status)) redirect(`/releases/${id}?err=${encodeURIComponent("Choose a status.")}`);
  if (status === "Signed off" || status === "Released") {
    const signoff = await prisma.signoff.findUnique({ where: { releaseId: id } });
    if (!signoff || signoff.recommendation === "No-go") redirect(`/releases/${id}?err=${encodeURIComponent(`${status} needs a Go or Go with conditions sign-off first.`)}`);
  }
  const before = await prisma.release.update({ where: { id }, data: { status }, select: { name: true } });
  await audit(user, "release.status", { releaseId: id, target: before.name, detail: status });
  revalidatePath(`/releases/${id}`);
}
