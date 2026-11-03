import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { STAGES, computeMetrics, evaluateGates, ensureStages, gateForStage, pct, THRESHOLDS } from "@/lib/workflow";
import { ReleaseNav } from "@/components/ReleaseNav";
import { Badge, statusTone } from "@/components/Badge";
import { Notice } from "@/components/Notice";
import { setStageStatus } from "./actions";
import { setReleaseStatus } from "../actions";

export const dynamic = "force-dynamic";

export default async function ReleaseBoard({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const { id } = await params; const sp = await searchParams;
  const release = await prisma.release.findUnique({ where: { id } });
  if (!release) notFound();
  await ensureStages(id);
  const [stages, metrics] = await Promise.all([prisma.stageStatus.findMany({ where: { releaseId: id } }), computeMetrics(id)]);
  const gates = await evaluateGates(id, metrics);
  const verdict = gates[4].met ? "Go" : "No-go";
  const byNo = new Map<number, { status: string; note: string }>(stages.map((s) => [s.stageNo, { status: s.status, note: s.note }]));
  const current = STAGES.find((s) => (byNo.get(s.no)?.status ?? "Pending") !== "Done");

  return (
    <>
      <div className="row spread">
        <div>
          <h1>{release.name}</h1>
          <p className="muted">Workflow board. Stage {current ? `${current.no}, ${current.name}` : "complete"}. Gates evaluate automatically from stories, builds, executions and bugs. Stages 1, 2 and 11 follow their flows; set the others yourself.</p>
        </div>
        <form action={setReleaseStatus} className="row">
          <input type="hidden" name="id" value={id} />
          <select name="status" defaultValue={release.status} style={{ width: "auto" }}>
            {["Active", "Signed off", "Released", "Closed"].map((s) => <option key={s}>{s}</option>)}
          </select>
          <button className="secondary small" type="submit">Set status</button>
        </form>
      </div>
      <ReleaseNav releaseId={id} active="board" />
      <Notice searchParams={sp} />

      <div className="tiles">
        <div className="card tile"><p className="label">Gate 5 verdict</p><div className={`big ${verdict === "Go" ? "ok" : "bad"}`}>{verdict}</div><p className="sub">Build {metrics.latestBuild ?? "none"}</p></div>
        <div className="card tile"><p className="label">Open Critical / High</p><div className={`big ${metrics.openCriticalHigh ? "bad" : "ok"}`}>{metrics.openCriticalHigh}</div><p className="sub">Target 0 at sign-off</p></div>
        <div className="card tile"><p className="label">P1 pass rate</p><div className={`big ${metrics.passRate.P1 >= THRESHOLDS.P1_PASS_RATE ? "ok" : "bad"}`}>{pct(metrics.passRate.P1)}</div><p className="sub">Threshold {pct(THRESHOLDS.P1_PASS_RATE)}</p></div>
        <div className="card tile"><p className="label">Execution progress</p><div className="big">{pct(metrics.progress)}</div><p className="sub">{metrics.executed} of {metrics.planned} approved cases</p></div>
        <div className="card tile"><p className="label">Requirement coverage</p><div className={`big ${metrics.requirementCoverage >= 1 ? "ok" : "warn"}`}>{pct(metrics.requirementCoverage)}</div><p className="sub">{metrics.storiesCovered} of {metrics.stories} stories</p></div>
        <div className="card tile"><p className="label">Human-verified P1</p><div className={`big ${metrics.humanVerifiedRate >= 1 ? "ok" : "warn"}`}>{pct(metrics.humanVerifiedRate)}</div><p className="sub">{metrics.p1HumanVerified} of {metrics.p1AiExecuted} AI-run P1</p></div>
      </div>

      <h2>Gates</h2>
      <div className="gates">
        {gates.map((g) => (
          <div className="gate-card" key={g.no}>
            <div className="row spread"><strong>Gate {g.no}: {g.name}</strong><Badge tone={g.met ? "ok" : "bad"}>{g.met ? "Met" : "Not met"}</Badge></div>
            {!g.met && <ul>{g.reasons.slice(0, 6).map((r, i) => <li key={i}>{r}</li>)}{g.reasons.length > 6 && <li>and {g.reasons.length - 6} more</li>}</ul>}
          </div>
        ))}
      </div>

      <h2>13 stages</h2>
      <div className="board">
        {STAGES.map((s) => {
          const row = byNo.get(s.no);
          const status = row?.status ?? "Pending";
          const gateNo = gateForStage(s.no);
          const gate = gateNo ? gates[gateNo - 1] : null;
          return (
            <div className={`stage ${status.replace(" ", ".")}`} key={s.no}>
              <div className="row spread"><span className="no">Stage {s.no}</span><Badge tone={statusTone(status)}>{status}</Badge></div>
              <div className="name"><Link href={s.href(id)}>{s.name}</Link></div>
              {s.gate && <div className="gate">{s.gate} {gate && <Badge tone={gate.met ? "ok" : "bad"}>{gate.met ? "met" : "not met"}</Badge>}</div>}
              {row?.note && <div className="muted" style={{ fontSize: ".8rem" }}>{row.note}</div>}
              <div className="tools">{s.tools}</div>
              <details>
                <summary className="muted" style={{ fontSize: ".78rem" }}>Update</summary>
                <form action={setStageStatus} className="stack" style={{ marginTop: ".4rem" }}>
                  <input type="hidden" name="releaseId" value={id} />
                  <input type="hidden" name="stageNo" value={s.no} />
                  <select name="status" defaultValue={status}>{["Pending", "In progress", "Done", "Failed"].map((x) => <option key={x}>{x}</option>)}</select>
                  <input name="note" defaultValue={row?.note ?? ""} placeholder="Note (what was done, what blocked)" />
                  <button className="small" type="submit">Save</button>
                </form>
              </details>
            </div>
          );
        })}
      </div>
      <p className="muted" style={{ marginTop: "1rem" }}>A stage with a gate cannot be marked Done while its gate reads "not met". Stage 8 (Non-functional lane) marked Done is what Gate 5 reads as NFR green.</p>
    </>
  );
}
