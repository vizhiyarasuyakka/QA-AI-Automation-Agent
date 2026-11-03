import { AutoRefresh } from "./AutoRefresh";
import { Badge } from "./Badge";

type Job = { kind: string; status: string; phase: string; engine: string; storiesTotal: number; storiesDone: number; casesAdded: number; gapsLeft: number; log: string; startedAt: Date; finishedAt: Date | null };

const NAMES: Record<string, string> = { prd: "Story list", testcases: "Generation", playwright: "Script generation", "pw-run": "Script run", chrome: "Chrome run", criteria: "Acceptance criteria check", "ui-extract": "Trigger search", "ui-run": "UI test run", "ui-match": "Prototype comparison" };

export function JobPanel({ job }: { job: Job | null }) {
  if (!job) return null;
  const running = job.status === "Running";
  const name = NAMES[job.kind] ?? "Run";
  const generated = job.kind === "testcases";
  const units = job.kind === "pw-run" ? "script files" : job.kind === "criteria" ? "criteria" : job.kind === "chrome" ? "cases" : job.kind === "ui-run" ? "triggers" : job.kind === "ui-extract" || job.kind === "ui-match" ? "screens" : "stories";
  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      {running && <AutoRefresh />}
      <div className="row spread">
        <strong>{running ? `${name} running` : `Last ${name.toLowerCase()}`}</strong>
        <Badge tone={job.status === "Done" ? (job.gapsLeft ? "warn" : "ok") : job.status === "Failed" ? "bad" : "accent"}>{job.status === "Done" && job.gapsLeft ? "Done with gaps" : job.status}</Badge>
      </div>
      <p className="muted" style={{ margin: ".4rem 0" }}>
        {running && `${job.phase}. This page refreshes itself; you can leave it. `}
        {job.storiesDone} of {job.storiesTotal} {units}{generated ? `, ${job.casesAdded} cases added, ${job.gapsLeft} requirements still uncovered` : ""}. Using {job.engine || "claude"}. Started {job.startedAt.toLocaleTimeString("en-IN")}{job.finishedAt ? `, finished ${job.finishedAt.toLocaleTimeString("en-IN")}` : ""}.
      </p>
      {job.log && <details open={job.status === "Failed"}><summary>Run log</summary><pre className="block" style={{ marginTop: ".5rem", whiteSpace: "pre-wrap" }}>{job.log}</pre></details>}
    </div>
  );
}
