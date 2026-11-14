"use server";

import { redirect } from "next/navigation";
import { audit, hashPassword, isRole, passwordProblem, requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const back = (kind: "ok" | "err", message: string) => redirect(`/settings/users?${kind}=${encodeURIComponent(message)}`);

/** True when the change would leave nobody who can manage users. */
async function lastAdmin(userId: string) {
  const admins = await prisma.user.findMany({ where: { role: "Admin", active: true }, select: { id: true } });
  return admins.length === 1 && admins[0].id === userId;
}

export async function createUser(formData: FormData) {
  const me = await requireRole("Admin", "add users");
  const email = s(formData, "email").toLowerCase(), name = s(formData, "name"), role = s(formData, "role");
  const password = String(formData.get("password") ?? "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) back("err", "Enter a valid email.");
  if (!name) back("err", "Enter the person's name.");
  if (!isRole(role)) back("err", "Choose a role.");
  const weak = passwordProblem(password);
  if (weak) back("err", weak);
  if (await prisma.user.findUnique({ where: { email } })) back("err", `${email} already has an account.`);
  const user = await prisma.user.create({ data: { email, name, role, passwordHash: await hashPassword(password) } });
  await audit(me, "user.create", { target: email, detail: `role ${role}` });
  back("ok", `${user.email} added as ${role}. Share the password with them privately.`);
}

export async function updateUser(formData: FormData) {
  const me = await requireRole("Admin", "change users");
  const id = s(formData, "id"), role = s(formData, "role"), active = formData.get("active") === "on";
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) back("err", "That user no longer exists.");
  if (!isRole(role)) back("err", "Choose a role.");
  if ((role !== "Admin" || !active) && user!.role === "Admin" && user!.active && (await lastAdmin(id))) back("err", "This is the only active Admin. Make someone else Admin first.");
  const changes = [user!.role !== role && `role ${user!.role} → ${role}`, user!.active !== active && (active ? "reactivated" : "deactivated")].filter(Boolean).join(", ");
  if (!changes) back("ok", "Nothing changed.");
  // A role change or deactivation ends the person's current sessions, so the new rights apply at once.
  await prisma.user.update({ where: { id }, data: { role, active, sessionVersion: { increment: 1 } } });
  await audit(me, "user.update", { target: user!.email, detail: changes });
  back("ok", `${user!.email}: ${changes}.`);
}

export async function resetPassword(formData: FormData) {
  const me = await requireRole("Admin", "reset passwords");
  const id = s(formData, "id"), password = String(formData.get("password") ?? "");
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) back("err", "That user no longer exists.");
  const weak = passwordProblem(password);
  if (weak) back("err", weak);
  await prisma.user.update({ where: { id }, data: { passwordHash: await hashPassword(password), sessionVersion: { increment: 1 } } });
  await audit(me, "user.password_reset", { target: user!.email });
  back("ok", `Password reset for ${user!.email}. Their other sessions are signed out.`);
}
