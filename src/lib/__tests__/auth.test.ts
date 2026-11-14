import { describe, expect, it, vi } from "vitest";

// Only the pure parts are tested here; the database and request scope are not needed.
vi.mock("../prisma", () => ({ prisma: {} }));
vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

const { atLeast, clearFailures, hashPassword, lockedFor, noteFailure, passwordProblem, verifyPassword } = await import("../auth");

describe("passwords", () => {
  it("hashes with a salt and verifies", async () => {
    const a = await hashPassword("Correct horse 42");
    const b = await hashPassword("Correct horse 42");
    expect(a).not.toBe(b);
    expect(a.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("Correct horse 42", a)).toBe(true);
    expect(await verifyPassword("correct horse 42", a)).toBe(false);
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
  });

  it("asks for a reasonable password", () => {
    expect(passwordProblem("short1")).toMatch(/12 characters/);
    expect(passwordProblem("onlyletterslong")).toMatch(/digit/);
    expect(passwordProblem("Release2026Gate")).toBeNull();
  });
});

describe("roles", () => {
  it("orders Viewer < QA Engineer < QA Lead < Admin", () => {
    expect(atLeast("Admin", "QA Lead")).toBe(true);
    expect(atLeast("QA Lead", "QA Lead")).toBe(true);
    expect(atLeast("QA Engineer", "QA Lead")).toBe(false);
    expect(atLeast("Viewer", "QA Engineer")).toBe(false);
    expect(atLeast("Superuser", "Viewer")).toBe(false);
  });
});

describe("sign-in throttling", () => {
  it("locks an account for 15 minutes after 5 failures", () => {
    const email = "lock@test.local", t = 1_000_000;
    for (let i = 0; i < 4; i++) noteFailure(email, t);
    expect(lockedFor(email, t)).toBe(0);
    noteFailure(email, t);
    expect(lockedFor(email, t)).toBe(15);
    expect(lockedFor(email, t + 15 * 60 * 1000 + 1)).toBe(0);
    clearFailures(email);
  });
});
