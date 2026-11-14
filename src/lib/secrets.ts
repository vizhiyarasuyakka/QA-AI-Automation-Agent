import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Secrets at rest: test-account passwords, API sign-in values and integration tokens are stored as
 * enc:v1:<iv>:<tag>:<ciphertext> (AES-256-GCM, base64), with the key from SECRETS_KEY (32 bytes, base64).
 * A value without the prefix is a legacy plain value: it still reads, and `npm run secrets:encrypt` converts it.
 */
const PREFIX = "enc:v1:";

export class SecretsKeyError extends Error {}

function key(): Buffer {
  const raw = process.env.SECRETS_KEY ?? "";
  if (!raw) throw new SecretsKeyError("SECRETS_KEY is not set. Run npm run keys and add the printed SECRETS_KEY to .env, then restart the app.");
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) throw new SecretsKeyError("SECRETS_KEY must be 32 bytes, base64 encoded. Run npm run keys for a new one.");
  return k;
}

export const isEncrypted = (value: string) => value.startsWith(PREFIX);

/** Empty stays empty, so "no password" needs no key. An already encrypted value is returned as is. */
export function encryptSecret(plain: string): string {
  if (!plain || isEncrypted(plain)) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${PREFIX}${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
}

/** A plain legacy value passes through. A value that fails to decrypt (wrong key, tampered) throws rather than leak garbage. */
export function decryptSecret(stored: string): string {
  if (!stored || !isEncrypted(stored)) return stored;
  const [iv, tag, ct] = stored.slice(PREFIX.length).split(":");
  if (!iv || !tag || !ct) throw new Error("A stored secret is malformed.");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}

/** Settings rows that hold secrets. Everything else in Setting is configuration and stays readable. */
export const SECRET_SETTINGS = new Set(["BUG_WEBHOOK_TOKEN", "BUG_MCP_TOKEN", "IMPORT_TOKEN"]);
