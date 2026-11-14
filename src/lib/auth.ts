import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "./prisma";
import { SESSION_COOKIE, SESSION_HOURS, signSession, verifySession } from "./session";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

export const ROLES = ["Admin", "QA Lead", "QA Engineer", "Viewer"] as const;
export type Role = (typeof ROLES)[number];
const RANK: Record<Role, number> = { Viewer: 0, "QA Engineer": 1, "QA Lead": 2, Admin: 3 };
export const isRole = (r: string): r is Role => (ROLES as readonly string[]).includes(r);
export const atLeast = (role: string, min: Role) => isRole(role) && RANK[role] >= RANK[min];

export type SessionUser = { id: string; email: string; name: string; role: Role };

/* ---------- passwords ---------- */

const N = 16384, R = 8, P = 1, LEN = 64;
export const MIN_PASSWORD = 12;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, LEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const got = await scrypt(password, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD) return `The password needs at least ${MIN_PASSWORD} characters.`;
  if (!/[a-z]/i.test(password) || !/\d/.test(password)) return "The password needs letters and at least one digit.";
  return null;
}

/* ---------- sign-in throttling ---------- */

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const fails = ((globalThis as unknown as { __qaLoginFails?: Map<string, { n: number; until: number }> }).__qaLoginFails ??= new Map());

/** Minutes left on a lock, or 0. Keyed by email, so one account cannot be guessed at from many places either. */
export function lockedFor(email: string, now = Date.now()): number {
  const f = fails.get(email);
  return f && f.until > now ? Math.ceil((f.until - now) / 60000) : 0;
}
export function noteFailure(email: string, now = Date.now()) {
  const f = fails.get(email);
  const n = (f && f.until > now ? 0 : f?.n ?? 0) + 1;
  fails.set(email, { n: n >= MAX_FAILS ? 0 : n, until: n >= MAX_FAILS ? now + LOCK_MS : 0 });
}
export const clearFailures = (email: string) => void fails.delete(email);

/* ---------- sessions ---------- */

/** Behind a TLS proxy the browser talks HTTPS, so the cookie must be Secure; on plain http://localhost it cannot be. */
async function secureCookie(): Promise<boolean> {
  if (process.env.AUTH_COOKIE_SECURE) return process.env.AUTH_COOKIE_SECURE === "true";
  const h = await headers();
  return (h.get("x-forwarded-proto") ?? "").split(",")[0].trim() === "https";
}

export async function startSession(user: { id: string; sessionVersion: number }) {
  const token = await signSession({ sub: user.id, ver: user.sessionVersion });
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: await secureCookie(), path: "/", maxAge: SESSION_HOURS * 3600 });
}

export async function endSession() {
  (await cookies()).delete(SESSION_COOKIE);
}

/** The signed-in user, checked against the database every time: a deactivated user or a reset password ends the session at once. */
export async function currentUser(): Promise<SessionUser | null> {
  const p = await verifySession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!p) return null;
  const u = await prisma.user.findUnique({ where: { id: p.sub }, select: { id: true, email: true, name: true, role: true, active: true, sessionVersion: true } });
  if (!u || !u.active || u.sessionVersion !== p.ver || !isRole(u.role)) return null;
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}

/** Back to the page the form was on, with the message, or to /releases. Only a same-site path is followed. */
async function back(message: string): Promise<never> {
  const h = await headers();
  let path = "/releases";
  try {
    const ref = new URL(h.get("referer") ?? "");
    if (ref.host === h.get("host")) path = ref.pathname;
  } catch {}
  redirect(`${path}?err=${encodeURIComponent(message)}`);
}

/** For server actions and pages: signed in, and at least `min`. Redirects to sign-in, or back with the reason. */
export async function requireRole(min: Role = "Viewer", what = "do this"): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (!atLeast(user.role, min)) return back(`Only ${min === "Admin" ? "an Admin" : `a ${min} or above`} can ${what}. You are signed in as ${user.role}.`);
  return user;
}

/* ---------- audit ---------- */

export async function audit(user: Pick<SessionUser, "id" | "email"> | null, action: string, opts: { releaseId?: string | null; target?: string; detail?: string } = {}) {
  await prisma.auditLog.create({
    data: { userId: user?.id ?? null, userEmail: user?.email ?? "", action, releaseId: opts.releaseId ?? null, target: (opts.target ?? "").slice(0, 300), detail: (opts.detail ?? "").slice(0, 2000) },
  });
}
