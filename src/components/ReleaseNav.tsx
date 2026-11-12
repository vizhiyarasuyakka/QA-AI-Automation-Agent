import Link from "next/link";
import { flowStates, type FlowState } from "@/lib/flows";
import { prisma } from "@/lib/prisma";

type Key = "board" | "documents" | "stories" | "review" | "automation" | "execution" | "ui" | "api" | "security" | "bugs" | "signoff";

/** The release's route sheet: each workflow step in order, with where it stands. */
export async function ReleaseNav({ releaseId, active }: { releaseId: string; active: Key }) {
  const [f, release] = await Promise.all([flowStates(releaseId), prisma.release.findUnique({ where: { id: releaseId }, select: { name: true, status: true } })]);
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
