import { runProblems } from "@/lib/jobs";
import { AutoRefresh } from "./AutoRefresh";

type Job = { kind: string; status: string; storiesTotal: number; storiesDone: number; casesAdded: number; log: string };

/** Step 2 shows a loader while a run is going, and afterwards only what went wrong, instead of the run log. */
export function JobLoader({ job }: { job: Job | null }) {
  if (!job) return null;
  if (job.status === "Running") {
    const generating = job.kind === "testcases";
    return (
      <div className="card loader" role="status" style={{ marginBottom: "1rem" }}>
        <AutoRefresh />
        <span className="spinner" aria-hidden="true" />
        <div>
          <strong>{generating ? "Creating test cases and test data" : "Loading your user stories"}</strong>
          <div className="muted">{generating ? `${job.storiesDone} of ${job.storiesTotal} stories done, ${job.casesAdded} cases so far. You can leave this page; it keeps running.` : "This takes a few seconds."}</div>
        </div>
      </div>
    );
  }
  const problems = runProblems(job.log);
  if (!problems.length && job.status !== "Failed") return null;
  return (
    <div className="notice warn" style={{ marginBottom: "1rem" }}>
      <strong>{job.status === "Failed" ? "The last run failed." : "The last run finished with problems."}</strong>
      {problems.slice(0, 5).map((p, i) => <div key={i} style={{ overflowWrap: "anywhere" }}>{p}</div>)}
      {problems.length > 5 && <div>And {problems.length - 5} more.</div>}
    </div>
  );
}
