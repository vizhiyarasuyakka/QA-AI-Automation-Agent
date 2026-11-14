import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, isEncrypted, SecretsKeyError } from "../secrets";

describe("secrets at rest", () => {
  const saved = process.env.SECRETS_KEY;
  beforeEach(() => { process.env.SECRETS_KEY = randomBytes(32).toString("base64"); });
  afterEach(() => { process.env.SECRETS_KEY = saved; });

  it("round-trips and never stores the plain value", () => {
    const stored = encryptSecret("Test@Pass123");
    expect(isEncrypted(stored)).toBe(true);
    expect(stored).not.toContain("Test@Pass123");
    expect(decryptSecret(stored)).toBe("Test@Pass123");
  });

  it("uses a fresh IV each time", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("leaves empty and already encrypted values alone", () => {
    expect(encryptSecret("")).toBe("");
    const once = encryptSecret("x");
    expect(encryptSecret(once)).toBe(once);
  });

  it("reads legacy plain values as they are", () => {
    expect(decryptSecret("old-plain-password")).toBe("old-plain-password");
  });

  it("refuses a tampered value", () => {
    const stored = encryptSecret("secret-value");
    const tampered = stored.slice(0, -4) + (stored.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("refuses to decrypt with another key", () => {
    const stored = encryptSecret("secret-value");
    process.env.SECRETS_KEY = randomBytes(32).toString("base64");
    expect(() => decryptSecret(stored)).toThrow();
  });

  it("will not write a secret without a key", () => {
    delete process.env.SECRETS_KEY;
    expect(() => encryptSecret("x")).toThrow(SecretsKeyError);
  });
});
