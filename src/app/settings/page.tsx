import Link from "next/link";
import { BUG_FIELDS, REPORT_FIELDS, getSetting } from "@/lib/webhook";
import { claudeConnection } from "@/lib/claude";
import { FLOW_LABELS, inventory, selectedEngine, type Flow } from "@/lib/engines";
import type { McpTool } from "@/lib/mcp";
import { Badge } from "@/components/Badge";
import { EnginePicker } from "@/components/EnginePicker";
import { Notice } from "@/components/Notice";
import { connectMcp, recheckConnections, saveMcpTool, saveReportTool, saveSettings } from "./actions";
import { THRESHOLDS } from "@/lib/workflow";

export const dynamic = "force-dynamic";

const STEP_USE: Record<Flow, string> = {
  testcases: "Reads the stories from the stored files, then writes test cases and test data until every criterion and field rule is covered.",
  playwright: "Turns test cases into stored Playwright specs.",
  execution: "Runs test cases and records pass or fail.",
  ui: "Compares each built screen with its prototype, and tests the triggers on it.",
  bugs: "Sends confirmed bugs and the pass and fail report to your tracker.",
};

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ ok?: string; err?: string; info?: string }> }) {
  const sp = await searchParams;
  const [url, token, importToken, conn, mcpUrl, mcpToken, mcpToolsJson, mcpTool, mcpArgs, reportTool, reportArgs, inv] = await Promise.all([
    getSetting("BUG_WEBHOOK_URL"), getSetting("BUG_WEBHOOK_TOKEN"), getSetting("IMPORT_TOKEN"), claudeConnection(),
    getSetting("BUG_MCP_URL"), getSetting("BUG_MCP_TOKEN"), getSetting("BUG_MCP_TOOLS"), getSetting("BUG_MCP_TOOL"), getSetting("BUG_MCP_ARGS"),
    getSetting("REPORT_MCP_TOOL"), getSetting("REPORT_MCP_ARGS"), inventory(),
  ]);
  const mcpTools: McpTool[] = mcpToolsJson ? JSON.parse(mcpToolsJson) : [];
  const flows = Object.keys(FLOW_LABELS) as Flow[];
  const chosen = Object.fromEntries(await Promise.all(flows.map(async (f) => [f, await selectedEngine(f)] as const))) as Record<Flow, string>;
  const inUse = (id: string) => flows.filter((f) => chosen[f] === id);
  const usable = inv.skills.filter((s) => s.flows.length);
  const other = inv.skills.filter((s) => !s.flows.length);
  const flowNames = (list: Flow[]) => list.map((f) => FLOW_LABELS[f]).join(", ");

  return (
    <>
      {inv.mcp === null && <meta httpEquiv="refresh" content="6" />}
      <h1>Settings and connections</h1>
      <p className="muted">What is connected on this machine, which workflow step uses it, and when. Read live from Claude Code.</p>
      <Notice searchParams={sp} />

      <h2>What each step uses</h2>
      <div className="card" style={{ marginBottom: "1rem" }}>
        <p className="muted"><Badge tone={conn.ok ? "ok" : "bad"}>{conn.ok ? "Claude connected" : "Claude not connected"}</Badge> {conn.detail}. Model: {process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5"}.</p>
        {flows.map((f) => (
          <div key={f} className="step-row">
            <div><strong>{FLOW_LABELS[f]}</strong><div className="muted">{STEP_USE[f]}</div></div>
            {f === "execution"
              ? <p className="muted" style={{ margin: 0 }}>Both are always on the Test execution page: record results by hand, or run the ticked cases in Chrome through Claude in Chrome.</p>
              : <EnginePicker flow={f} back="/settings" />}
          </div>
        ))}
      </div>

      <div className="row spread"><h2>Skills that fit a step ({usable.length})</h2><form action={recheckConnections}><button className="small secondary" type="submit">Check connections again</button></form></div>
      <div className="card" style={{ marginBottom: "1rem" }}>
        <div className="tbox">
          <table>
            <thead><tr><th>Skill</th><th>Used in</th><th>Use it when</th><th>Now</th></tr></thead>
            <tbody>
              {usable.map((s) => {
                const on = inUse(`skill:${s.plugin}:${s.skill}`);
                return (
                  <tr key={`${s.plugin}:${s.skill}`}>
                    <td><strong>{s.plugin}:{s.skill}</strong></td>
                    <td>{flowNames(s.flows)}</td>
                    <td>{s.when}{s.tested && <> <Badge tone="ok">Tested here</Badge></>}</td>
                    <td>{on.length ? <Badge tone="accent">In use</Badge> : <span className="muted">Available</span>}</td>
                  </tr>
                );
              })}
              {!usable.length && <tr><td colSpan={4} className="muted">No enabled plugin has a skill that fits these steps.</td></tr>}
            </tbody>
          </table>
        </div>
        {other.length > 0 && (
          <details style={{ marginTop: ".75rem" }}>
            <summary>Other enabled skills, not used by a step ({other.length})</summary>
            <table style={{ marginTop: ".5rem" }}>
              <thead><tr><th>Skill</th><th>Why not</th></tr></thead>
              <tbody>{other.map((s) => <tr key={`${s.plugin}:${s.skill}`}><td>{s.plugin}:{s.skill}</td><td className="muted">{s.when}</td></tr>)}</tbody>
            </table>
          </details>
        )}
      </div>

      <h2>Plugins ({inv.plugins.length})</h2>
      <div className="card" style={{ marginBottom: "1rem" }}>
        <table>
          <thead><tr><th>Plugin</th><th>State</th><th>Skills</th><th>Fit a step</th></tr></thead>
          <tbody>{inv.plugins.map((p) => <tr key={p.id}><td>{p.id}</td><td><Badge tone={p.enabled ? "ok" : undefined}>{p.enabled ? "Enabled" : "Off"}</Badge></td><td>{p.skills}</td><td>{usable.filter((s) => s.plugin === p.id).length}</td></tr>)}</tbody>
        </table>
      </div>

      <h2>MCP servers in Claude Code</h2>
      <div className="card" style={{ marginBottom: "1rem" }}>
        {inv.mcp === null ? <p className="muted">Checking each server. This page refreshes itself.</p> : (
          <table>
            <thead><tr><th>Server</th><th>State</th><th>Used in</th><th>Note</th></tr></thead>
            <tbody>{inv.mcp.map((m) => <tr key={m.name}><td>{m.name}</td><td><Badge tone={m.ok ? "ok" : "warn"}>{m.status}</Badge></td><td>{m.flows.length ? flowNames(m.flows) : <span className="muted">No step</span>}</td><td className="muted">{m.when}</td></tr>)}</tbody>
          </table>
        )}
      </div>

      <h2>Bug tracker MCP connector</h2>
      <div className="card" style={{ marginBottom: "1rem" }}>
        <p className="muted">Used by <Link href="/releases">step 7</Link> to send bugs and the pass and fail report to your web application. It needs a URL and an optional token; a server that signs in through a browser cannot connect here.</p>
        <form action={connectMcp} className="stack">
          <div className="fields">
            <label><span>MCP server URL</span><input name="BUG_MCP_URL" defaultValue={mcpUrl} placeholder="https://qa.yourcompany.com/mcp" /></label>
            <label><span>Bearer token (optional)</span><input name="BUG_MCP_TOKEN" defaultValue={mcpToken} type="password" /></label>
          </div>
          <div><button type="submit">Save and connect</button> {mcpTools.length > 0 && <Badge tone="ok">Connected, {mcpTools.length} tools</Badge>}</div>
        </form>
        {mcpTools.length > 0 && (
          <div className="grid-2" style={{ marginTop: "1rem" }}>
            <form action={saveMcpTool} className="stack">
              <label><span>Tool that creates a bug</span>
                <select name="BUG_MCP_TOOL" defaultValue={mcpTool}><option value="">Choose a tool</option>{mcpTools.map((t) => <option key={t.name} value={t.name}>{t.name}{t.description ? `: ${t.description.slice(0, 70)}` : ""}</option>)}</select>
              </label>
              <label><span>Bug arguments, filled in when you choose a tool</span><textarea name="BUG_MCP_ARGS" defaultValue={mcpArgs} className="mono" style={{ minHeight: "9rem" }} /></label>
              <p className="muted" style={{ fontSize: ".82rem" }}>Available: {BUG_FIELDS.map((f) => `{{${f}}}`).join(" ")}</p>
              <div><button type="submit" className="secondary">Save bug tool</button></div>
            </form>
            <form action={saveReportTool} className="stack">
              <label><span>Tool that receives the pass and fail report</span>
                <select name="REPORT_MCP_TOOL" defaultValue={reportTool}><option value="">Choose a tool</option>{mcpTools.map((t) => <option key={t.name} value={t.name}>{t.name}{t.description ? `: ${t.description.slice(0, 70)}` : ""}</option>)}</select>
              </label>
              <label><span>Report arguments, filled in when you choose a tool</span><textarea name="REPORT_MCP_ARGS" defaultValue={reportArgs} className="mono" style={{ minHeight: "9rem" }} /></label>
              <p className="muted" style={{ fontSize: ".82rem" }}>Available: {REPORT_FIELDS.map((f) => `{{${f}}}`).join(" ")}</p>
              <div><button type="submit" className="secondary">Save report tool</button></div>
            </form>
          </div>
        )}
      </div>

      <div className="grid-2">
        <div className="card">
          <h3>Other integrations</h3>
          <form action={saveSettings} className="stack">
            <label><span>Bug webhook URL (accepts JSON POST; used when Bug logging is set to Webhook)</span><input name="BUG_WEBHOOK_URL" defaultValue={url} placeholder="https://qa.yourcompany.com/api/bugs" /></label>
            <label><span>Bug webhook bearer token (optional)</span><input name="BUG_WEBHOOK_TOKEN" defaultValue={token} type="password" /></label>
            <label><span>Import token for /api/import/* (optional, sent as X-Import-Token)</span><input name="IMPORT_TOKEN" defaultValue={importToken} type="password" /></label>
            <div><button type="submit">Save</button></div>
          </form>
        </div>
        <div className="card">
          <h3>Thresholds (edit in src/lib/workflow.ts)</h3>
          <table><tbody>
            <tr><td>P1 pass rate for Gate 5</td><td>{THRESHOLDS.P1_PASS_RATE * 100}%</td></tr>
            <tr><td>Automation stability</td><td>{THRESHOLDS.AUTOMATION_STABILITY * 100}% over last {THRESHOLDS.STABILITY_WINDOW} runs</td></tr>
            <tr><td>Automation coverage of P1 regression</td><td>{THRESHOLDS.AUTOMATION_COVERAGE * 100}%</td></tr>
            <tr><td>Reopen rate max</td><td>{THRESHOLDS.REOPEN_RATE_MAX * 100}%</td></tr>
            <tr><td>Mean time to fix Critical/High</td><td>{THRESHOLDS.MTTF_HIGH_HOURS} h</td></tr>
          </tbody></table>
        </div>
      </div>
    </>
  );
}
