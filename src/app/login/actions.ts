"use server";

import { redirect } from "next/navigation";
import { audit, clearFailures, lockedFor, noteFailure, startSession, verifyPassword } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/** A same-site path only, so a crafted link cannot send a person elsewhere after signing in. */
const safeNext = (next: string) => (next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") && !next.startsWith("/login") ? next : "/releases");

export async function signIn(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = safeNext(String(formData.get("next") ?? ""));
  const again = (message: string) => redirect(`/login?err=${encodeURIComponent(message)}&next=${encodeURIComponent(next)}`);
  if (!email || !password) again("Enter your email and password.");

  const minutes = lockedFor(email);
  if (minutes) again(`Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`);

  const user = await prisma.user.findUnique({ where: { email } });
  const ok = !!user && user.active && (await verifyPassword(password, user.passwordHash));
  if (!user || !ok) {
    noteFailure(email);
    await audit(user ? { id: user.id, email } : null, "login.fail", { target: email, detail: user && !user.active ? "account deactivated" : "wrong email or password" });
    again("Wrong email or password, or the account is deactivated.");
  }
  clearFailures(email);
  await prisma.user.update({ where: { id: user!.id }, data: { lastLoginAt: new Date() } });
  await startSession(user!);
  await audit(user!, "login.ok");
  redirect(next);
}
