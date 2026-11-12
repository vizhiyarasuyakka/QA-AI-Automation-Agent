import { prisma } from "./prisma";

/** "prd" lists the user stories from the stored files. */
export type JobKind = "prd" | "testcases" | "playwright" | "pw-run" | "chrome" | "criteria" | "ui-extract" | "ui-run" | "ui-match" | "api-tests" | "api-run" | "story-checks" | "story-run" | "security";
type Counters = { phase?: string; storiesTotal?: number; storiesDone?: number; casesAdded?: number; gapsLeft?: number };
export type JobCtx = { log: (line: string) => void; set: (c: Counters) => Promise<unknown> };

/** Jobs started by this server process. A Running row not in here was orphaned by a restart. */
const live = ((globalThis as unknown as { __qaLiveJobs?: Set<string> }).__qaLiveJobs ??= new Set<string>());

export async function runningJob(releaseId: string) {
  const running = await prisma.generationJob.findMany({ where: { releaseId, status: "Running" } });
  for (const j of running) {
    if (live.has(j.id)) return j;
    await prisma.generationJob.update({ where: { id: j.id }, data: { status: "Failed", finishedAt: new Date(), log: `${j.log}\nServer restarted during this run. Trigger it again.`.trim() } });
  }
  return null;
}

/** Runs in the background so the trigger returns at once. `work` returns the job's final status. */
export async function launchJob(opts: { releaseId: string; kind: JobKind; engine: string; storyRefId?: string; work: (ctx: JobCtx) => Promise<"Done" | "Failed">; after?: () => Promise<unknown> }) {
  const job = await prisma.generationJob.create({ data: { releaseId: opts.releaseId, kind: opts.kind, engine: opts.engine, storyRefId: opts.storyRefId ?? null, phase: "Starting" } });
  live.add(job.id);
  const lines: string[] = [];
  const counters: Counters = {};
  const ctx: JobCtx = {
    log: (line) => void lines.push(line),
    set: (c) => prisma.generationJob.update({ where: { id: job.id }, data: { ...Object.assign(counters, c), log: lines.join("\n") } }),
  };
  void (async () => {
    let status: "Done" | "Failed" = "Failed";
    try {
      status = await opts.work(ctx);
    } catch (e) {
      lines.push(`Run failed. ${e instanceof Error ? e.message : String(e)}`);
    }
    // Written last with the full counters, because the progress writes above can land out of order.
    await prisma.generationJob.update({ where: { id: job.id }, data: { ...counters, status, phase: "Finished", finishedAt: new Date(), log: lines.join("\n") } });
    live.delete(job.id);
    await opts.after?.();
  })();
  return job;
}

/** The lines of a run log a person needs to act on. */
export function runProblems(log: string) {
  return log.split("\n").map((l) => l.trim()).filter((l) => /: failed\.|still uncovered|Stopped after|Skipped because|could not|Run failed|name no user stories/.test(l));
}

export function latestJob(releaseId: string, kind: JobKind) {
  return prisma.generationJob.findFirst({ where: { releaseId, kind }, orderBy: { startedAt: "desc" } });
}
