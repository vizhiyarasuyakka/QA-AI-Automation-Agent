/**
 * The sign-in cookie: <payload>.<signature>, both base64url, signed with HMAC-SHA256 and AUTH_SECRET.
 * The payload names the user and their session version; the user row decides the role and whether they may still sign in.
 * Uses Web Crypto only, so the middleware and the server actions share it.
 */
export const SESSION_COOKIE = "qa_session";
export const SESSION_HOURS = 12;

export type SessionPayload = { sub: string; ver: number; exp: number };

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

export function authSecret(): string {
  const secret = process.env.AUTH_SECRET ?? "";
  if (secret.length < 32) throw new Error("AUTH_SECRET is missing or shorter than 32 characters. Run npm run keys and add it to .env.");
  return secret;
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

/** Constant time for equal lengths, so a forged signature cannot be found byte by byte. */
function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function signSession(p: Omit<SessionPayload, "exp">, secret = authSecret(), now = Date.now()): Promise<string> {
  const payload: SessionPayload = { ...p, exp: Math.floor(now / 1000) + SESSION_HOURS * 3600 };
  const body = b64url(enc.encode(JSON.stringify(payload)));
  return `${body}.${b64url(await hmac(secret, body))}`;
}

/** Null for anything not signed by us, malformed, or expired. */
export async function verifySession(token: string | undefined, secret = authSecret(), now = Date.now()): Promise<SessionPayload | null> {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  try {
    if (!same(await hmac(secret, body), fromB64url(sig))) return null;
    const p = JSON.parse(new TextDecoder().decode(fromB64url(body))) as SessionPayload;
    if (typeof p.sub !== "string" || typeof p.ver !== "number" || typeof p.exp !== "number") return null;
    return p.exp * 1000 > now ? p : null;
  } catch {
    return null;
  }
}
