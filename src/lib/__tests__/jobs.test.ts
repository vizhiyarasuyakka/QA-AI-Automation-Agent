import { describe, expect, it, vi } from "vitest";

vi.mock("../prisma", () => ({ prisma: {} }));
vi.mock("../targets", () => ({ runTargetProblem: vi.fn() }));

const { isOrphaned, STALE_MS } = await import("../jobs");
const { JobCancelled, jobScope, throwIfCancelled } = await import("../jobscope");

describe("job heartbeat", () => {
  const now = 10_000_000;
  const started = new Date(now - 10 * 60_000);

  it("is never orphaned while this server runs it", () => {
    expect(isOrphaned({ id: "a", heartbeatAt: null, startedAt: started }, true, now)).toBe(false);
  });

  it("is live on another server while its heartbeat is fresh", () => {
    expect(isOrphaned({ id: "a", heartbeatAt: new Date(now - 20_000), startedAt: started }, false, now)).toBe(false);
  });

  it("is orphaned once no server has beaten for a minute", () => {
    expect(isOrphaned({ id: "a", heartbeatAt: new Date(now - STALE_MS - 1), startedAt: started }, false, now)).toBe(true);
  });

  it("falls back to the start time for jobs from before heartbeats", () => {
    expect(isOrphaned({ id: "a", heartbeatAt: null, startedAt: started }, false, now)).toBe(true);
  });
});

describe("cancelling", () => {
  it("lets work go on until the job is cancelled, then stops it with who asked", () => {
    const scope = { jobId: "j", releaseId: "r", kind: "testcases", cancelled: false, cancelledBy: "" };
    jobScope.run(scope, () => {
      expect(() => throwIfCancelled()).not.toThrow();
      Object.assign(scope, { cancelled: true, cancelledBy: "Test Lead" });
      expect(() => throwIfCancelled()).toThrow(JobCancelled);
      expect(() => throwIfCancelled()).toThrow("Cancelled by Test Lead.");
    });
  });

  it("does nothing outside a job", () => {
    expect(() => throwIfCancelled()).not.toThrow();
  });
});
