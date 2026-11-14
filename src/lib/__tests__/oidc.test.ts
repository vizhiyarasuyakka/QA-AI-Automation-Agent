import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("../prisma", () => ({ prisma: {} }));
vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

const { identity, openPending, safeNext, sealPending, validateIdToken, oidcConfig } = await import("../oidc");

const ISS = "https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0";
const CLIENT = "client-abc";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1" };
const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;

function token(claims: Record<string, unknown>, opts: { key?: typeof privateKey; kid?: string; alg?: string } = {}) {
  const h = Buffer.from(JSON.stringify({ alg: opts.alg ?? "RS256", kid: opts.kid ?? "k1", typ: "JWT" })).toString("base64url");
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const s = sign("RSA-SHA256", Buffer.from(`${h}.${p}`), opts.key ?? privateKey).toString("base64url");
  return `${h}.${p}.${s}`;
}
const now = Date.now();
const good = { iss: ISS, aud: CLIENT, exp: Math.floor(now / 1000) + 600, nbf: Math.floor(now / 1000) - 10, nonce: "n1", sub: "s1", oid: "o1", preferred_username: "Lead@Company.com", name: "Test Lead" };
const check = (t: string, nonce = "n1") => validateIdToken(t, { keys: [jwk], issuer: ISS, clientId: CLIENT, nonce, now });

describe("ID token", () => {
  it("accepts a token signed by the provider's key for this app and sign-in", () => {
    expect(check(token(good)).oid).toBe("o1");
  });
  it("refuses another key's signature", () => expect(() => check(token(good, { key: other }))).toThrow(/signature/));
  it("refuses an unknown key id", () => expect(() => check(token(good, { kid: "nope" }))).toThrow(/unknown key/));
  it("refuses alg none and HS256", () => {
    expect(() => check(token(good, { alg: "none" }))).toThrow(/RS256/);
    expect(() => check(token(good, { alg: "HS256" }))).toThrow(/RS256/);
  });
  it("refuses another issuer, another app, a wrong nonce, an expired token", () => {
    expect(() => check(token({ ...good, iss: "https://login.microsoftonline.com/other/v2.0" }))).toThrow(/issuer/);
    expect(() => check(token({ ...good, aud: "someone-else" }))).toThrow(/another application/);
    expect(() => check(token(good), "n2")).toThrow(/this sign-in/);
    expect(() => check(token({ ...good, exp: Math.floor(now / 1000) - 600 }))).toThrow(/expired/);
  });
  it("refuses an edited payload", () => {
    const [h, , s] = token(good).split(".");
    const forged = Buffer.from(JSON.stringify({ ...good, preferred_username: "admin@company.com" })).toString("base64url");
    expect(() => check(`${h}.${forged}.${s}`)).toThrow(/signature/);
  });
});

describe("who signed in", () => {
  it("uses Entra's verified sign-in name, not the editable email claim", () => {
    expect(identity({ ...good, email: "admin@company.com" } as never).email).toBe("lead@company.com");
  });
  it("binds the account to issuer and object id", () => {
    expect(identity(good as never).subject).toBe(`${ISS}|o1`);
  });
  it("refuses an unverified email from other providers", () => {
    expect(() => identity({ ...good, iss: "https://accounts.example.com", email: "x@company.com", email_verified: false } as never)).toThrow(/not verified/);
  });
});

describe("sign-in state", () => {
  const SECRET = "s".repeat(48);
  it("round-trips, refuses tampering and expires after 10 minutes", () => {
    const sealed = sealPending({ state: "st", nonce: "n", verifier: "v", next: "/releases" }, SECRET, now);
    expect(openPending(sealed, SECRET, now)?.state).toBe("st");
    expect(openPending(sealed.replace(/.$/, (c) => (c === "A" ? "B" : "A")), SECRET, now)).toBeNull();
    expect(openPending(sealed, "t".repeat(48), now)).toBeNull();
    expect(openPending(sealed, SECRET, now + 11 * 60_000)).toBeNull();
  });
  it("only returns to a path on this site", () => {
    expect(safeNext("/releases/1")).toBe("/releases/1");
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "/login?x"]) expect(safeNext(bad)).toBe("/releases");
  });
});

describe("configuration", () => {
  it("is off without issuer, client id and secret, and never gives Admin to new accounts", () => {
    expect(oidcConfig({} as NodeJS.ProcessEnv)).toBeNull();
    const cfg = oidcConfig({ OIDC_ISSUER: `${ISS}/`, OIDC_CLIENT_ID: "c", OIDC_CLIENT_SECRET: "x", OIDC_DEFAULT_ROLE: "Admin", OIDC_ALLOWED_DOMAINS: "@Company.com, partner.io" } as unknown as NodeJS.ProcessEnv);
    expect(cfg).toMatchObject({ issuer: ISS, defaultRole: "Viewer", allowedDomains: ["company.com", "partner.io"] });
  });
});
