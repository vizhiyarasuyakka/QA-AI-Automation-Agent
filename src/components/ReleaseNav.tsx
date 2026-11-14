import Link from "next/link";
import { flowStates, type FlowState } from "@/lib/flows";
import { runningJob } from "@/lib/jobs";
import { prisma } from "@/lib/prisma";

const JOB_NAMES: Record<string, string> = { prd: "Story list", testcases: "Generation", playwright: "Script writing", "pw-run": "Script run", chrome: "Chrome run", criteria: "AC check", "ui-extract": "Trigger search", "ui-run": "UI test run", "ui-match": "Prototype comparison", "api-tests": "API test writing", "api-run": "API test run", "story-checks": "Story check writing", "story-run": "Story check run", security: "Security scan" };

type Key = "board" | "documents" | "stories" | "review" | "automation" | "execution" | "ui" | "api" | "security" | "bugs" | "signoff";

/** The release's route sheet: each workflow step in order, with where it stands. */
export async function ReleaseNav({ releaseId, active }: { releaseId: string; active: Key }) {
  const [f, release, job] = await Promise.all([flowStates(releaseId), prisma.release.findUnique({ where: { id: releaseId }, select: { name: true, status: true } }), runningJob(releaseId)]);
  const steps: [string, string, Key, FlowState][] = [
    [`/releases/${releaseId}/documents`, "Requirement docs", "documents", f.files],
    [`/releases/${releaseId}/stories`, "TC/TD: test cases and test data", "stories", f.testcases],
    [`/releases/${releaseId}/review`, "Test case review", "review", f.review],
    [`/releases/${releaseId}/execution`, "AC Check", "execution", f.execution],
    [`/releases/${releaseId}/automation`, "Playwright Test", "automation", f.playwright],
    [`/releases/${releaseId}/api-testing`, "API Test", "api", f.api],
    [`/releases/${releaseId}/ui-testing`, "UI Testing", "ui", f.ui],
    [`/releases/${releaseId}/security`, "Security Testing", "security", f.security],
    [`/releases/${releaseId}/bugs`, "Bugs and reports", "bugs", f.bugs],
  ];
  return (
    <nav className="rail" aria-label="Workflow steps">
      <div className="rail-head">
        <Link href="/releases" className="rail-back">All releases</Link>
        <strong>{release?.name}</strong>
        <span className="muted">{release?.status}</span>
      </div>
      {job && (
        <div className="rail-job" role="status">
          <span className="spinner small" aria-hidden="true" /> <strong>{JOB_NAMES[job.kind] ?? "A run"} running</strong>
          <div className="muted">{job.cancelRequested ? `Cancelling (asked by ${job.cancelledBy})…` : job.phase}</div>
          {!job.cancelRequested && <form action={`/releases/${releaseId}/jobs/${job.id}/cancel`} method="post"><button type="submit" className="small secondary">Cancel run</button></form>}
        </div>
      )}
      <Link href={`/releases/${releaseId}`} className={`rail-plain ${active === "board" ? "active" : ""}`}>Workflow board</Link>
      <ol>
        {steps.map(([href, label, key, state], i) => (
          <li key={key} className={`tone-${state.tone ?? "none"} ${key === active ? "active" : ""}`}>
            <Link href={href} title={state.detail} aria-current={key === active ? "page" : undefined}>
              <span className="rail-no">{i + 1}</span>
              <span className="rail-text"><span>{label}</span><small>{state.status}</small></span>
            </Link>
          </li>
        ))}
      </ol>
      <Link href={`/releases/${releaseId}/signoff`} className={`rail-plain ${active === "signoff" ? "active" : ""}`}>Sign-off and report</Link>
    </nav>
  );
}
