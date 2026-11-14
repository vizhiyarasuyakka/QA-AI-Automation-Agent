import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { authorizeUrl, discovery, oidcConfig, pkcePair, randomToken, safeNext, sealPending, STATE_COOKIE } from "@/lib/oidc";
import { authSecret } from "@/lib/session";

export const dynamic = "force-dynamic";

/** First leg of single sign-on: remember state, nonce and the PKCE verifier, then send the browser to the provider. */
export async function GET(req: Request) {
  const cfg = oidcConfig();
  if (!cfg) redirect("/login?err=Single%20sign-on%20is%20not%20set%20up%20on%20this%20server.");
  const url = new URL(req.url);
  const redirectUri = cfg.redirectUri ?? `${url.origin}/login/oidc/callback`;
  let target: string;
  try {
    const d = await discovery(cfg);
    const { verifier, challenge } = pkcePair();
    const state = randomToken(), nonce = randomToken();
    (await cookies()).set(STATE_COOKIE, sealPending({ state, nonce, verifier, next: safeNext(url.searchParams.get("next") ?? "") }, authSecret()), {
      httpOnly: true, sameSite: "lax", secure: url.protocol === "https:" || process.env.AUTH_COOKIE_SECURE === "true", path: "/login/oidc", maxAge: 600,
    });
    target = authorizeUrl(d, cfg, redirectUri, { state, nonce, challenge });
  } catch (e) {
    redirect(`/login?err=${encodeURIComponent(e instanceof Error ? e.message : "Single sign-on could not start.")}`);
  }
  redirect(target);
}
