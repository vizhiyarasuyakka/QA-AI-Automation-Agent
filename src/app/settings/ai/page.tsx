import Link from "next/link";
import { Badge } from "@/components/Badge";
import { requireRole } from "@/lib/auth";
import { apiKeyRequired } from "@/lib/claude";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const DAYS = 30;
const KIND_NAMES: Record<string, string> = { "": "Outside a run", prd: "Story list", testcases: "Test case generation", playwright: "Script writing", chrome: "Chrome run", criteria: "AC check", "ui-extract": "Trigger search", "ui-run": "UI test run", "ui-match": "Prototype comparison", "api-tests": "API test writing", "story-checks": "Story check writing", "story-run": "Story check run" };

type Row = { calls: number; failed: number; ms: number; inTok: number; outTok: number; cost: number };
const empty = (): Row => ({ calls: 0, failed: 0, ms: 0, inTok: 0, outTok: 0, cost: 0 });
const fmt = (n: number) => n.toLocaleString("en-IN");
const usd = (n: number) => (n ? `$${n.toFixed(2)}` : "—");

export default async function AiUsagePage() {
  await requireRole("QA Lead", "see AI usage");
  const since = new Date(Date.now() - DAYS * 86400_000);
  const [calls, releases, aiCases, aiReviewed] = await Promise.all([
    prisma.aiCall.findMany({ where: { at: { gte: since } }, orderBy: { at: "desc" }, select: { at: true, kind: true, via: true, ok: true, error: true, ms: true, inputTokens: true, outputTokens: true, costUsd: true, releaseId: true } }),
    prisma.release.findMany({ select: { id: true, name: true } }),
    prisma.testCase.groupBy({ by: ["storyId"], where: { source: "ai" }, _count: { _all: true } }),
    prisma.testCase.groupBy({ by: ["storyId"], where: { source: "ai", reviewed: true }, _count: { _all: true } }),
  ]);
  const names = new Map(releases.map((r) => [r.id, r.name]));
  const add = (m: Map<string, Row>, key: string, c: (typeof calls)[number]) => {
    const r = m.get(key) ?? empty();
    r.calls++; if (!c.ok) r.failed++; r.ms += c.ms; r.inTok += c.inputTokens; r.outTok += c.outputTokens; r.cost += c.costUsd;
    m.set(key, r);
  };
  const byKind = new Map<string, Row>(), byRelease = new Map<string, Row>(), byVia = new Map<string, Row>();
  const total = empty();
  for (const c of calls) {
    add(byKind, c.kind, c); add(byRelease, c.releaseId ?? "", c); add(byVia, c.via, c);
    total.calls++; if (!c.ok) total.failed++; total.ms += c.ms; total.inTok += c.inputTokens; total.outTok += c.outputTokens; total.cost += c.costUsd;
  }
  const failures = calls.filter((c) => !c.ok && c.error !== "cancelled").slice(0, 20);

  // AI-written test cases a person has reviewed, per release.
  const stories = await prisma.story.findMany({ where: { id: { in: aiCases.map((g) => g.storyId) } }, select: { id: true, releaseId: true } });
  const storyRelease = new Map(stories.map((s) => [s.id, s.releaseId]));
  const cases = new Map<string, { written: number; reviewed: number }>();
  for (const g of aiCases) { const r = storyRelease.get(g.storyId) ?? ""; const v = cases.get(r) ?? { written: 0, reviewed: 0 }; v.written += g._count._all; cases.set(r, v); }
  for (const g of aiReviewed) { const r = storyRelease.get(g.storyId) ?? ""; const v = cases.get(r) ?? { written: 0, reviewed: 0 }; v.reviewed += g._count._all; cases.set(r, v); }

  const table = (title: string, m: Map<string, Row>, label: (k: string) => React.ReactNode) => (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <h3>{title}</h3>
      <div className="tbox">
        <table>
          <thead><tr><th></th><th className="num">Calls</th><th className="num">Failed</th><th className="num">Avg time</th><th className="num">Tokens in</th><th className="num">Tokens out</th><th className="num">Cost</th></tr></thead>
          <tbody>
            {[...m.entries()].sort((a, b) => b[1].calls - a[1].calls).map(([k, r]) => (
              <tr key={k || "none"}><td>{label(k)}</td><td className="num">{fmt(r.calls)}</td><td className="num">{r.failed ? <Badge tone="bad">{r.failed}</Badge> : 0}</td><td className="num">{(r.ms / r.calls / 1000).toFixed(1)} s</td><td className="num">{fmt(r.inTok)}</td><td className="num">{fmt(r.outTok)}</td><td className="num">{usd(r.cost)}</td></tr>
            ))}
            {!m.size && <tr><td colSpan={7} className="muted">No model calls in the last {DAYS} days.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <>
      <h1>AI usage</h1>
      <p className="muted">Every request to Claude or ChatGPT in the last {DAYS} days: how many, how many failed, how long they took, and what they cost. Tokens and cost come from the API, or from Claude Code when it reports them; ChatGPT through Codex reports neither. {apiKeyRequired() ? "This deployment uses the organisation's API key only." : "Requests without ANTHROPIC_API_KEY run on this machine's Claude Code login; set AI_REQUIRE_API_KEY=true to allow the API key only."}</p>

      <div className="grid-2" style={{ marginBottom: "1rem" }}>
        <div className="card"><p className="label">Calls</p><div className="big">{fmt(total.calls)}</div><p className="sub">{total.failed} failed ({total.calls ? Math.round((total.failed / total.calls) * 100) : 0}%)</p></div>
        <div className="card"><p className="label">Reported cost</p><div className="big">{usd(total.cost)}</div><p className="sub">{fmt(total.inTok)} tokens in, {fmt(total.outTok)} out</p></div>
      </div>

      {table("By step", byKind, (k) => KIND_NAMES[k] ?? k)}
      {table("By release", byRelease, (k) => (k ? <Link href={`/releases/${k}`}>{names.get(k) ?? "(deleted release)"}</Link> : <span className="muted">Not tied to a release</span>))}
      {table("By connection", byVia, (k) => <span className="mono">{k}</span>)}

      <div className="card" style={{ marginBottom: "1rem" }}>
        <h3>AI-written test cases reviewed by a person</h3>
        <p className="muted">How much of what the model wrote has been looked at. Low numbers mean cases are reaching execution unchecked.</p>
        <table>
          <thead><tr><th>Release</th><th className="num">AI-written cases</th><th className="num">Reviewed</th><th className="num">Share</th></tr></thead>
          <tbody>
            {[...cases.entries()].map(([r, v]) => <tr key={r}><td>{names.get(r) ?? "(deleted release)"}</td><td className="num">{fmt(v.written)}</td><td className="num">{fmt(v.reviewed)}</td><td className="num">{v.written ? Math.round((v.reviewed / v.written) * 100) : 0}%</td></tr>)}
            {!cases.size && <tr><td colSpan={4} className="muted">No AI-written test cases yet.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Latest failures</h3>
        <table>
          <thead><tr><th>When</th><th>Step</th><th>Connection</th><th>Error</th></tr></thead>
          <tbody>
            {failures.map((c, i) => <tr key={i}><td style={{ whiteSpace: "nowrap" }}>{c.at.toLocaleString("en-IN")}</td><td>{KIND_NAMES[c.kind] ?? c.kind}</td><td className="mono">{c.via}</td><td className="muted" style={{ overflowWrap: "anywhere" }}>{c.error}</td></tr>)}
            {!failures.length && <tr><td colSpan={4} className="muted">No failed calls.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
