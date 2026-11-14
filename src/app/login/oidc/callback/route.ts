import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { audit, startSession } from "@/lib/auth";
import { discovery, domainAllowed, exchangeCode, identity, oidcConfig, openPending, STATE_COOKIE } from "@/lib/oidc";
import { prisma } from "@/lib/prisma";
import { authSecret } from "@/lib/session";

export const dynamic = "force-dynamic";

const fail = (m: string): never => redirect(`/login?err=${encodeURIComponent(m)}`);

/**
 * Second leg: the provider sends the browser back with a code. The code is exchanged for an ID token whose signature,
 * issuer, audience, expiry and nonce are checked; then the person is matched to an account, or one is made for them.
 */
export async function GET(req: Request) {
  const cfg = oidcConfig();
  if (!cfg) fail("Single sign-on is not set up on this server.");
  const url = new URL(req.url);
  const jar = await cookies();
  const pending = openPending(jar.get(STATE_COOKIE)?.value, authSecret());
  jar.delete({ name: STATE_COOKIE, path: "/login/oidc" });

  const providerError = url.searchParams.get("error");
  if (providerError) fail(`The sign-in provider said: ${url.searchParams.get("error_description") ?? providerError}`.slice(0, 300));
  if (!pending) fail("The sign-in took too long or was started in another browser. Try again.");
  if (url.searchParams.get("state") !== pending!.state) fail("The sign-in response does not match this browser. Try again.");
  const code = url.searchParams.get("code");
  if (!code) fail("The sign-in provider sent no code.");

  let who: ReturnType<typeof identity>;
  try {
    const d = await discovery(cfg!);
    const claims = await exchangeCode(d, cfg!, { code: code!, redirectUri: cfg!.redirectUri ?? `${url.origin}/login/oidc/callback`, verifier: pending!.verifier, nonce: pending!.nonce });
    who = identity(claims);
  } catch (e) {
    await audit(null, "login.fail", { detail: `single sign-on: ${e instanceof Error ? e.message : String(e)}` });
    return fail(e instanceof Error ? e.message : "Single sign-on failed.");
  }
  if (!who.email.includes("@")) fail("The sign-in provider did not give an email address for this account.");

  // The same person on later sign-ins: by the provider's id first, then by email (an account an Admin made ahead).
  let user = (await prisma.user.findUnique({ where: { oidcSubject: who.subject } })) ?? (await prisma.user.findUnique({ where: { email: who.email } }));
  if (user && user.oidcSubject && user.oidcSubject !== who.subject) {
    await audit(user, "login.fail", { detail: `single sign-on: ${who.email} is bound to another identity` });
    fail("This email is linked to a different sign-in identity. Ask an Admin.");
  }
  if (!user) {
    if (!domainAllowed(who.email, cfg!)) {
      await audit(null, "login.fail", { target: who.email, detail: "single sign-on: email domain not allowed" });
      fail(`${who.email} cannot get an account here. Ask an Admin to add you.`);
    }
    user = await prisma.user.create({ data: { email: who.email, name: who.name, role: cfg!.defaultRole, passwordHash: "", oidcSubject: who.subject } });
    await audit(user, "user.create", { target: who.email, detail: `first single sign-on, role ${cfg!.defaultRole}` });
  } else if (!user.oidcSubject) {
    user = await prisma.user.update({ where: { id: user.id }, data: { oidcSubject: who.subject } });
  }
  if (!user.active) {
    await audit(user, "login.fail", { detail: "single sign-on: account deactivated" });
    fail("Your account is deactivated. Ask an Admin.");
  }
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await startSession(user);
  await audit(user, "login.ok", { detail: "single sign-on" });
  redirect(pending!.next);
}
