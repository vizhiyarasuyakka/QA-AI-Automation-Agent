import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify as verifySig, type JsonWebKey } from "node:crypto";
import { isRole, type Role } from "./auth";

/**
 * Single sign-on with OpenID Connect: authorization code flow with PKCE, the ID token's signature checked against the
 * provider's published keys. Built for Microsoft Entra ID and works with any standard provider.
 *
 *   OIDC_ISSUER          https://login.microsoftonline.com/<tenant-id>/v2.0
 *   OIDC_CLIENT_ID       the app registration's Application (client) ID
 *   OIDC_CLIENT_SECRET   a client secret of that registration
 *   OIDC_REDIRECT_URI    optional; default <this site>/login/oidc/callback (register exactly this in Entra)
 *   OIDC_ALLOWED_DOMAINS optional; comma-separated email domains allowed to get an account on first sign-in
 *   OIDC_DEFAULT_ROLE    role for a new account, default Viewer; an Admin raises it in Users
 *   OIDC_ONLY            "true" hides the password form (an Admin can still reach it at /login?password=1)
 *   OIDC_LABEL           button text, default "Sign in with Microsoft"
 */
export type OidcConfig = { issuer: string; clientId: string; clientSecret: string; redirectUri?: string; allowedDomains: string[]; defaultRole: Role; only: boolean; label: string };

export function oidcConfig(env = process.env): OidcConfig | null {
  const issuer = (env.OIDC_ISSUER ?? "").replace(/\/+$/, "");
  if (!issuer || !env.OIDC_CLIENT_ID || !env.OIDC_CLIENT_SECRET) return null;
  const role = env.OIDC_DEFAULT_ROLE ?? "Viewer";
  return {
    issuer, clientId: env.OIDC_CLIENT_ID, clientSecret: env.OIDC_CLIENT_SECRET, redirectUri: env.OIDC_REDIRECT_URI || undefined,
    allowedDomains: (env.OIDC_ALLOWED_DOMAINS ?? "").split(",").map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean),
    defaultRole: isRole(role) && role !== "Admin" ? role : "Viewer",
    only: env.OIDC_ONLY === "true", label: env.OIDC_LABEL || "Sign in with Microsoft",
  };
}

type Discovery = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string };
const cache = ((globalThis as unknown as { __qaOidc?: { disc?: { at: number; d: Discovery; for: string }; jwks?: { at: number; keys: JsonWebKey[]; for: string } } }).__qaOidc ??= {});
const HOUR = 3600_000;

export async function discovery(cfg: OidcConfig): Promise<Discovery> {
  if (cache.disc && cache.disc.for === cfg.issuer && Date.now() - cache.disc.at < HOUR) return cache.disc.d;
  const res = await fetch(`${cfg.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`The sign-in provider's configuration could not be read (${res.status}).`);
  const d = (await res.json()) as Discovery;
  // A shared Entra endpoint lets accounts of any organisation sign in; only your own tenant's issuer is accepted.
  if (d.issuer.includes("{tenantid}") || /\/(common|organizations|consumers)\//.test(cfg.issuer)) throw new Error("Single sign-on must use your organisation's own issuer (https://login.microsoftonline.com/<tenant-id>/v2.0), not common or organizations.");
  if (d.issuer.replace(/\/+$/, "") !== cfg.issuer) throw new Error(`OIDC_ISSUER does not match the provider's issuer (${d.issuer}).`);
  cache.disc = { at: Date.now(), d, for: cfg.issuer };
  return d;
}

async function keys(d: Discovery, force = false): Promise<JsonWebKey[]> {
  if (!force && cache.jwks && cache.jwks.for === d.jwks_uri && Date.now() - cache.jwks.at < HOUR) return cache.jwks.keys;
  const res = await fetch(d.jwks_uri, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`The sign-in provider's keys could not be read (${res.status}).`);
  const k = ((await res.json()) as { keys: JsonWebKey[] }).keys ?? [];
  cache.jwks = { at: Date.now(), keys: k, for: d.jwks_uri };
  return k;
}

const b64url = (b: Buffer) => b.toString("base64url");
export const pkcePair = () => {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
};
export const randomToken = () => b64url(randomBytes(24));

export function authorizeUrl(d: Discovery, cfg: OidcConfig, redirectUri: string, p: { state: string; nonce: string; challenge: string }) {
  const u = new URL(d.authorization_endpoint);
  u.search = new URLSearchParams({
    client_id: cfg.clientId, response_type: "code", redirect_uri: redirectUri, scope: "openid profile email",
    state: p.state, nonce: p.nonce, code_challenge: p.challenge, code_challenge_method: "S256", response_mode: "query",
  }).toString();
  return u.toString();
}

export type IdClaims = { iss: string; aud: string | string[]; exp: number; nbf?: number; iat?: number; nonce?: string; sub: string; oid?: string; tid?: string; email?: string; email_verified?: boolean; preferred_username?: string; upn?: string; name?: string };

/** Checks an ID token: RS256 signature by one of the provider's keys, issuer, audience, time and nonce. Throws on anything off. */
export function validateIdToken(token: string, opts: { keys: JsonWebKey[]; issuer: string; clientId: string; nonce: string; now?: number }): IdClaims {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) throw new Error("The ID token is malformed.");
  const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as { alg?: string; kid?: string };
  if (header.alg !== "RS256") throw new Error(`The ID token uses ${header.alg ?? "no"} signature; only RS256 is accepted.`);
  const jwk = opts.keys.find((k) => (k as { kid?: string }).kid === header.kid) ?? (opts.keys.length === 1 && !header.kid ? opts.keys[0] : undefined);
  if (!jwk) throw new Error("The ID token was signed by an unknown key.");
  const ok = verifySig("RSA-SHA256", Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(s, "base64url"));
  if (!ok) throw new Error("The ID token's signature is not valid.");
  const c = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as IdClaims;
  if (c.iss !== opts.issuer) throw new Error("The ID token is from another issuer.");
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(opts.clientId)) throw new Error("The ID token is for another application.");
  const now = Math.floor((opts.now ?? Date.now()) / 1000), skew = 120;
  if (typeof c.exp !== "number" || c.exp + skew < now) throw new Error("The ID token has expired.");
  if (typeof c.nbf === "number" && c.nbf - skew > now) throw new Error("The ID token is not valid yet.");
  if (!c.nonce || c.nonce !== opts.nonce) throw new Error("The ID token does not belong to this sign-in.");
  return c;
}

export async function exchangeCode(d: Discovery, cfg: OidcConfig, p: { code: string; redirectUri: string; verifier: string; nonce: string }): Promise<IdClaims> {
  const res = await fetch(d.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: p.code, redirect_uri: p.redirectUri, client_id: cfg.clientId, client_secret: cfg.clientSecret, code_verifier: p.verifier }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string; error_description?: string };
  if (!res.ok || !body.id_token) throw new Error(`The sign-in provider refused the code: ${body.error_description ?? body.error ?? res.status}`.slice(0, 300));
  const check = (k: JsonWebKey[]) => validateIdToken(body.id_token!, { keys: k, issuer: d.issuer, clientId: cfg.clientId, nonce: p.nonce });
  try {
    return check(await keys(d));
  } catch (e) {
    // The provider may have rotated its keys since they were cached (sometimes under the same key id): fetch them once more.
    if (!(e instanceof Error) || !/signature|unknown key/.test(e.message)) throw e;
    return check(await keys(d, true));
  }
}

/** The browser keeps state, nonce and PKCE verifier between the two legs, signed so they cannot be swapped, for 10 minutes. */
export const STATE_COOKIE = "qa_oidc";
type Pending = { state: string; nonce: string; verifier: string; next: string; exp: number };

export function sealPending(p: Omit<Pending, "exp">, secret: string, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...p, exp: now + 10 * 60_000 })).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

export function openPending(sealed: string | undefined, secret: string, now = Date.now()): Pending | null {
  const [body, sig] = (sealed ?? "").split(".");
  if (!body || !sig) return null;
  const want = createHmac("sha256", secret).update(body).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Pending;
    return p.exp > now ? p : null;
  } catch {
    return null;
  }
}

/** A same-site path only, so a crafted link cannot send a person elsewhere after signing in. */
export const safeNext = (next: string) => (next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") && !next.startsWith("/login") ? next : "/releases");

/**
 * Who signed in. Entra's `email` claim is not verified by Microsoft (anyone can type any address on their own
 * account), so for Entra the sign-in name is used, whose domain the tenant has verified. Other providers must not
 * mark the email unverified.
 */
export function identity(c: IdClaims) {
  const entra = /^https:\/\/login\.microsoftonline\.com\//.test(c.iss) || /^https:\/\/sts\.windows\.net\//.test(c.iss);
  if (!entra && c.email_verified === false) throw new Error("The sign-in provider says this email address is not verified.");
  const email = (entra ? c.preferred_username ?? c.upn ?? "" : c.email ?? c.preferred_username ?? "").trim().toLowerCase();
  return { email, name: (c.name ?? "").trim() || email.split("@")[0], subject: `${c.iss}|${c.oid ?? c.sub}` };
}

export function domainAllowed(email: string, cfg: OidcConfig) {
  if (!cfg.allowedDomains.length) return true;
  const domain = email.split("@")[1] ?? "";
  return cfg.allowedDomains.includes(domain);
}
