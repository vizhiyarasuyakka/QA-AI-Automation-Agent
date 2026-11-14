import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { SESSION_COOKIE, verifySession } from "@/lib/session";

/**
 * Every request needs a signed-in, active user, except the sign-in page, sign-out, and the CI imports (which carry
 * X-Import-Token instead). A Viewer may read but not change anything: every server action and form post is refused.
 * Runs on Node.js so the user row is checked on each request; a deactivated user is out on their next click.
 */
export const config = {
  runtime: "nodejs",
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

const PUBLIC = [/^\/login(\/|$)/, /^\/logout$/, /^\/api\/import\//];
const READ = new Set(["GET", "HEAD", "OPTIONS"]);

const cache = ((globalThis as unknown as { __qaMwUsers?: Map<string, { at: number; ok: boolean; role: string }> }).__qaMwUsers ??= new Map());
const CACHE_MS = 5000;

async function lookup(id: string, ver: number) {
  const key = `${id}:${ver}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  const u = await prisma.user.findUnique({ where: { id }, select: { active: true, sessionVersion: true, role: true } });
  const row = { at: Date.now(), ok: !!u && u.active && u.sessionVersion === ver, role: u?.role ?? "" };
  cache.set(key, row);
  return row;
}

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (PUBLIC.some((r) => r.test(pathname))) return NextResponse.next();

  const secret = process.env.AUTH_SECRET ?? "";
  if (secret.length < 32) return new NextResponse("AUTH_SECRET is not set (32+ characters). Run npm run keys, add it to .env and restart.", { status: 500 });

  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value, secret);
  const user = session ? await lookup(session.sub, session.ver) : null;
  if (!user?.ok) {
    if (READ.has(req.method) && !pathname.startsWith("/api/")) {
      const to = new URL("/login", req.url);
      to.searchParams.set("next", `${pathname}${search}`);
      const res = NextResponse.redirect(to);
      if (session) res.cookies.delete(SESSION_COOKIE);
      return res;
    }
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  }

  if (user.role === "Viewer" && !READ.has(req.method)) {
    return NextResponse.json({ error: "Viewers can read but not change anything." }, { status: 403 });
  }

  const res = NextResponse.next();
  // Evidence, reports and pages show test data; nothing signed-in belongs in a shared cache.
  res.headers.set("Cache-Control", "private, no-store");
  res.headers.set("X-Frame-Options", "SAMEORIGIN");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "same-origin");
  return res;
}
