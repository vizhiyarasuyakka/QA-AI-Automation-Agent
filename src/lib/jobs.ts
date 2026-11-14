import { JobCancelled, jobScope, type JobScope } from "./jobscope";
import { prisma } from "./prisma";
import { runTargetProblem } from "./targets";

/** "prd" lists the user stories from the stored files. */
export type JobKind = "prd" | "testcases" | "playwright" | "pw-run" | "chrome" | "criteria" | "ui-extract" | "ui-run" | "ui-match" | "api-tests" | "api-run" | "story-checks" | "story-run" | "security";
type Counters = { phase?: string; storiesTotal?: number; storiesDone?: number; casesAdded?: number; gapsLeft?: number };
export type JobCtx = { log: (line: string) => void; set: (c: Counters) => Promise<unknown>; cancelled: () => boolean };

/** Jobs started by this server process. */
const live = ((globalThis as unknown as { __qaLiveJobs?: Set<string> }).__qaLiveJobs ??= new Set<string>());

export const HEARTBEAT_MS = 15_000;
/** A Running job whose heartbeat is older than this, on no server, was orphaned by a restart or a crash. */
export const STALE_MS = 60_000;

export function isOrphaned(job: { id: string; heartbeatAt: Date | null; startedAt: Date }, isLocal: boolean, now = Date.now()) {
  if (isLocal) return false;
  const beat = (job.heartbeatAt ?? job.startedAt).getTime();
  return now - beat > STALE_MS;
}

export async function runningJob(releaseId: string) {
  const running = await prisma.generationJob.findMany({ where: { releaseId, status: "Running" }, orderBy: { startedAt: "desc" } });
  for (const j of running) {
    // Live here, or still beating on another server: either way it is running.
    if (!isOrphaned(j, live.has(j.id))) return j;
    await prisma.generationJob.update({ where: { id: j.id }, data: { status: "Failed", phase: "Finished", finishedAt: new Date(), log: `${j.log}\nThe server running this stopped during the run. Trigger it again.`.trim() } });
  }
  return null;
}

/** Asks a running job to stop. It stops at its next step: the next progress update, model call or check of a running test. */
export async function requestCancel(jobId: string, by: string) {
  const job = await prisma.generationJob.findUnique({ where: { id: jobId }, select: { status: true, releaseId: true, kind: true } });
  if (!job || job.status !== "Running") return null;
  await prisma.generationJob.update({ where: { id: jobId }, data: { cancelRequested: true, cancelledBy: by } });
  return job;
}

/**
 * Runs in the background so the trigger returns at once. `work` returns the job's final status.
 * While it runs, the job beats every 15 s, and each progress update checks whether someone cancelled it.
 */
export async function launchJob(opts: { releaseId: string; kind: JobKind; engine: string; storyRefId?: string; work: (ctx: JobCtx) => Promise<"Done" | "Failed">; after?: () => Promise<unknown> }) {
  const job = await prisma.generationJob.create({ data: { releaseId: opts.releaseId, kind: opts.kind, engine: opts.engine, storyRefId: opts.storyRefId ?? null, phase: "Starting", heartbeatAt: new Date() } });
  live.add(job.id);
  const lines: string[] = [];
  const counters: Counters = {};
  const scope: JobScope = { jobId: job.id, releaseId: opts.releaseId, kind: opts.kind, cancelled: false, cancelledBy: "" };

  const refreshCancel = async () => {
    if (scope.cancelled) return;
    const row = await prisma.generationJob.findUnique({ where: { id: job.id }, select: { cancelRequested: true, cancelledBy: true } });
    if (row?.cancelRequested) Object.assign(scope, { cancelled: true, cancelledBy: row.cancelledBy });
  };
  const beat = setInterval(() => {
    void prisma.generationJob.update({ where: { id: job.id }, data: { heartbeatAt: new Date() } }).then(refreshCancel).catch(() => {});
  }, HEARTBEAT_MS);
  beat.unref?.();

  const ctx: JobCtx = {
    log: (line) => void lines.push(line),
    set: async (c) => {
      await refreshCancel();
      if (scope.cancelled) throw new JobCancelled(`Cancelled by ${scope.cancelledBy || "a user"}.`);
      return prisma.generationJob.update({ where: { id: job.id }, data: { ...Object.assign(counters, c), log: lines.join("\n") } });
    },
    cancelled: () => scope.cancelled,
  };

  void jobScope.run(scope, async () => {
    let status: "Done" | "Failed" = "Failed";
    try {
      const refused = await runTargetProblem(opts.releaseId, opts.kind);
      if (refused) lines.push(`Run failed. ${refused}`);
      else status = await opts.work(ctx);
      // Work that swallowed the cancel inside a loop still ends as cancelled.
      if (scope.cancelled) { status = "Failed"; lines.push(`Cancelled by ${scope.cancelledBy || "a user"}. What finished before that is kept.`); }
    } catch (e) {
      lines.push(e instanceof JobCancelled ? `${e.message} What finished before that is kept.` : `Run failed. ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearInterval(beat);
    }
    // Written last with the full counters, because the progress writes above can land out of order.
    await prisma.generationJob.update({ where: { id: job.id }, data: { ...counters, status, phase: scope.cancelled ? "Cancelled" : "Finished", finishedAt: new Date(), log: lines.join("\n") } });
    live.delete(job.id);
    await opts.after?.();
  });
  return job;
}

/** The lines of a run log a person needs to act on. */
export function runProblems(log: string) {
  return log.split("\n").map((l) => l.trim()).filter((l) => /: failed\.|still uncovered|Stopped after|Skipped because|could not|Run failed|name no user stories|Cancelled by/.test(l));
}

export function latestJob(releaseId: string, kind: JobKind) {
  return prisma.generationJob.findFirst({ where: { releaseId, kind }, orderBy: { startedAt: "desc" } });
}
