import { describe, expect, it } from "vitest";
import { securityVerdict, signoffReasons, untriagedFailures } from "../gates";

/** Every Gate 5 input in its passing state; each test breaks one thing. */
const green = () => ({
  openBySeverity: { Critical: 0, High: 0, Medium: 0, Low: 0 },
  openHighWithoutWorkaround: 0,
  passRate: { P1: 1, P2: 1, P3: 1, all: 1 },
  progress: 1,
  humanVerifiedRate: 1,
  p1AiExecuted: 0,
  p1HumanVerified: 0,
  nfrGreen: true,
  securityNote: "latest scan has nothing High or Medium",
  runsConsidered: 0,
  automationStability: 0,
  untriaged: { ac: 0, api: 0, ui: 0 },
  otherPendingDrafts: 0,
});
const allMet = [{ name: "Gate 1", met: true }, { name: "Gate 2", met: true }, { name: "Gate 3", met: true }, { name: "Gate 4", met: true }];

describe("Gate 5", () => {
  it("is met when everything is green", () => {
    expect(signoffReasons(green(), allMet)).toEqual([]);
  });

  it("blocks Go while an API test failure sits untriaged", () => {
    expect(signoffReasons({ ...green(), untriaged: { ac: 0, api: 2, ui: 0 } }, allMet)).toEqual(["API Test: 2 failed tests not logged as a bug or dismissed"]);
  });

  it("blocks Go on an untriaged AC Check or UI difference", () => {
    const r = signoffReasons({ ...green(), untriaged: { ac: 1, api: 0, ui: 3 } }, allMet);
    expect(r).toContain("AC Check: 1 failed criterion not logged as a bug or dismissed");
    expect(r).toContain("UI Testing: 3 differences from the prototype or stories not logged as a bug or dismissed");
  });

  it("blocks Go on other pending drafts", () => {
    expect(signoffReasons({ ...green(), otherPendingDrafts: 1 }, allMet)).toEqual(["1 bug draft waiting in Bugs and reports: log or dismiss each"]);
  });

  it("explains why security is not green", () => {
    expect(signoffReasons({ ...green(), nfrGreen: false, securityNote: "no security scan has run" }, allMet)).toEqual(["security testing not green: no security scan has run"]);
  });

  it("still carries the earlier gates and the bug rules", () => {
    const r = signoffReasons({ ...green(), openBySeverity: { Critical: 1, High: 0, Medium: 0, Low: 0 } }, [{ name: "Gate 3", met: false }]);
    expect(r).toEqual(["Gate 3 not met", "1 Critical open"]);
  });
});

describe("security verdict", () => {
  it("needs a scan", () => expect(securityVerdict(null, "1.0").green).toBe(false));
  it("is not green while running or after a failed scan", () => {
    expect(securityVerdict({ status: "Running", buildNo: "1.0", highOrMedium: 0 }, "1.0").green).toBe(false);
    expect(securityVerdict({ status: "Failed", buildNo: "1.0", highOrMedium: 0 }, "1.0").green).toBe(false);
  });
  it("is not green with a High or Medium finding", () => {
    expect(securityVerdict({ status: "Done", buildNo: "1.0", highOrMedium: 1 }, "1.0")).toEqual({ green: false, note: "1 High or Medium finding on the latest scan" });
  });
  it("is not green when the scan is of an older build", () => {
    expect(securityVerdict({ status: "Done", buildNo: "1.0", highOrMedium: 0 }, "1.1").green).toBe(false);
  });
  it("is green for a clean scan of the latest build", () => {
    expect(securityVerdict({ status: "Done", buildNo: "1.1", highOrMedium: 0 }, "1.1").green).toBe(true);
  });
});

describe("triage of failures", () => {
  it("counts a failure until its draft is logged or dismissed", () => {
    const failing = { ac: ["criterion:a"], api: ["api:1", "api:2", "api:3"], ui: ["story:s", "match:m"] };
    const drafts = [
      { refKey: "api:1", status: "Logged" },
      { refKey: "api:2", status: "Dismissed" },
      { refKey: "api:3", status: "Pending" },
      { refKey: "story:s", status: "Pending" },
      { refKey: "exec:e1", status: "Pending" },
      { refKey: "sec:hsts", status: "Dismissed" },
    ];
    expect(untriagedFailures(failing, drafts)).toEqual({ untriaged: { ac: 1, api: 1, ui: 2 }, otherPendingDrafts: 1 });
  });
});
