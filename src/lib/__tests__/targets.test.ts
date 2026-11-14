import { describe, expect, it, vi } from "vitest";

vi.mock("../prisma", () => ({ prisma: {} }));
vi.mock("../webhook", () => ({ getSetting: vi.fn() }));

const { hostAllowed, neverAllowed, parseAllowlist, patternProblem } = await import("../targets");

describe("allowed test targets", () => {
  const list = parseAllowlist("qa.example.com\n*.staging.example.com\nlocalhost:3000\n# a comment\n\n10.0.0.5:8080");

  it("parses one pattern per line and skips comments", () => {
    expect(list).toEqual(["qa.example.com", "*.staging.example.com", "localhost:3000", "10.0.0.5:8080"]);
  });

  it("allows a listed host on any port, or only the listed port", () => {
    expect(hostAllowed("https://qa.example.com/login", list)).toBe(true);
    expect(hostAllowed("http://qa.example.com:8443/", list)).toBe(true);
    expect(hostAllowed("http://localhost:3000/app", list)).toBe(true);
    expect(hostAllowed("http://localhost:5433/", list)).toBe(false);
    expect(hostAllowed("http://10.0.0.5:8080/api", list)).toBe(true);
    expect(hostAllowed("http://10.0.0.5:22/", list)).toBe(false);
  });

  it("matches subdomains for *.domain, but not the bare domain or look-alikes", () => {
    expect(hostAllowed("https://app.staging.example.com", list)).toBe(true);
    expect(hostAllowed("https://a.b.staging.example.com", list)).toBe(true);
    expect(hostAllowed("https://staging.example.com", list)).toBe(false);
    expect(hostAllowed("https://evilstaging.example.com", list)).toBe(false);
    expect(hostAllowed("https://qa.example.com.evil.io", list)).toBe(false);
  });

  it("refuses everything when the list is empty", () => {
    expect(hostAllowed("https://qa.example.com", [])).toBe(false);
  });

  it("refuses other schemes and cloud metadata whatever the list says", () => {
    expect(hostAllowed("file:///etc/passwd", ["etc"])).toBe(false);
    expect(hostAllowed("http://169.254.169.254/latest/meta-data", ["169.254.169.254"])).toBe(false);
    expect(hostAllowed("http://metadata.google.internal/", ["metadata.google.internal"])).toBe(false);
    expect(neverAllowed("[fe80::1]")).toBe(true);
    expect(neverAllowed("qa.example.com")).toBe(false);
  });

  it("checks what an Admin types", () => {
    expect(patternProblem("qa.example.com")).toBeNull();
    expect(patternProblem("*.staging.example.com")).toBeNull();
    expect(patternProblem("localhost:3000")).toBeNull();
    expect(patternProblem("https://qa.example.com")).not.toBeNull();
    expect(patternProblem("*")).not.toBeNull();
    expect(patternProblem("qa.example.com/path")).not.toBeNull();
  });
});
