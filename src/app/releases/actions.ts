"use server";

import { prisma } from "@/lib/prisma";
import { ensureStages } from "@/lib/workflow";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

export async function createRelease(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) redirect("/releases?err=Release name is required");
  if (await prisma.release.findFirst({ where: { name } })) redirect(`/releases?err=${encodeURIComponent(`A release named ${name} already exists. CI results find a release by name, so names must be unique.`)}`);
  const r = await prisma.release.create({ data: { name } });
  await ensureStages(r.id);
  redirect(`/releases/${r.id}/documents?info=${encodeURIComponent("Upload the PRD, user stories and field documents to begin.")}`);
}

export async function deleteRelease(formData: FormData) {
  const id = String(formData.get("id"));
  await prisma.release.delete({ where: { id } });
  revalidatePath("/releases");
  redirect("/releases?ok=Release deleted");
}

export async function setReleaseStatus(formData: FormData) {
  const id = String(formData.get("id"));
  const status = String(formData.get("status"));
  if (status === "Signed off" || status === "Released") {
    const signoff = await prisma.signoff.findUnique({ where: { releaseId: id } });
    if (!signoff || signoff.recommendation === "No-go") redirect(`/releases/${id}?err=${encodeURIComponent(`${status} needs a Go or Go with conditions sign-off first.`)}`);
  }
  await prisma.release.update({ where: { id }, data: { status } });
  revalidatePath(`/releases/${id}`);
}
