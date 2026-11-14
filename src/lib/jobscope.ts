import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The job a piece of work belongs to, carried through every await without passing it by hand. Model calls read it to
 * record which release and job they were for, and to stop once a person has cancelled the job.
 * Kept free of imports so any module can use it without a cycle.
 */
export type JobScope = { jobId: string; releaseId: string; kind: string; cancelled: boolean; cancelledBy: string };

export const jobScope = new AsyncLocalStorage<JobScope>();

export class JobCancelled extends Error {}

export function throwIfCancelled() {
  const s = jobScope.getStore();
  if (s?.cancelled) throw new JobCancelled(`Cancelled by ${s.cancelledBy || "a user"}.`);
}

export const isCancelled = () => !!jobScope.getStore()?.cancelled;
