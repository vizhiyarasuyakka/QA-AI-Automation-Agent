import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { BUG_FIELDS, REPORT_FIELDS, getSetting, hasSetting } from "@/lib/webhook";
import { claudeConnection } from "@/lib/claude";
import { FLOW_LABELS, inventory, selectedEngine, type Flow } from "@/lib/engines";
import type { McpTool } from "@/lib/mcp";
import { Badge } from "@/components/Badge";
import { EnginePicker } from "@/components/EnginePicker";
import { Notice } from "@/components/Notice";
import { connectMcp, recheckConnections, saveMcpTool, saveReportTool, saveSettings, saveTargets } from "./actions";
import { prisma } from "@/lib/prisma";
import { allowlist, hostAllowed } from "@/lib/targets";
import { STAGES, STAGE_USES, THRESHOLDS } from "@/lib/workflow";

export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ ok?: string; err?: string; info?: string }> }) {
  const sp = await searchParams;
  const me = await requireRole("Viewer");
  const admin = me.role === "Admin";
  // Secrets are only ever reported as set or not; their values never reach the page.
  const [url, hasToken, hasImportToken, conn, mcpUrl, hasMcpToken, mcpToolsJson, mcpTool, mcpArgs, reportTool, reportArgs, inv] = await Promise.all([
    getSetting("BUG_WEBHOOK_URL"), hasSetting("BUG_WEBHOOK_TOKEN"), hasSetting("IMPORT_TOKEN"), claudeConnection(),
    getSetting("BUG_MCP_URL"), hasSetting("BUG_MCP_TOKEN"), getSetting("BUG_MCP_TOOLS"), getSetting("BUG_MCP_TOOL"), getSetting("BUG_MCP_ARGS"),
    getSetting("REPORT_MCP_TOOL"), getSetting("REPORT_MCP_ARGS"), inventory(),
  ]);
  const secretField = (name: string, label: string, saved: boolean) => (
    <label><span>{label} {saved ? <Badge tone="ok">Saved</Badge> : <Badge>Not set</Badge>}</span>
      <input name={name} type="password" autoComplete="new-password" placeholder={saved ? "Saved. Type a new value to replace it." : ""} disabled={!admin} />
      {saved && admin && <span className="row" style={{ gap: ".3rem", fontSize: 12 }}><input type="checkbox" name={`clear_${name}`} style={{ width: "auto" }} /> Remove it</span>}
    </label>
  );
  const mcpTools: McpTool[] = mcpToolsJson ? JSON.parse(mcpToolsJson) : [];
  // Hosts releases point at today, so an Admin sees which runs the allowlist would stop.
  const [targets, [buildUrls, apiUrls]] = await Promise.all([
    allowlist(),
    Promise.all([prisma.build.findMany({ select: { envUrl: true } }), prisma.apiTarget.findMany({ select: { baseUrl: true } })]),
  ]);
  const notAllowed = [...new Set([...buildUrls.map((b) => b.envUrl), ...apiUrls.map((t) => t.baseUrl)].filter(Boolean).filter((u) => !hostAllowed(u, targets)).map((u) => { try { return new URL(u).host; } catch { return u; } }))];
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

      <h2>What each stage uses</h2>
      <div className="card" style={{ marginBottom: "1rem" }}>
        <p className="muted"><Badge tone={conn.ok ? "ok" : "bad"}>{conn.ok ? "Claude connected" : "Claude not connected"}</Badge> {conn.detail}. Model: {process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5"}. Every tool named below is free; Claude, ChatGPT and plugin skills come in only where the third column says, and the connection for those stages is chosen in the last column.</p>
        <div className="tbox">
          <table>
            <thead><tr><th>Stage</th><th>Free tools</th><th>Claude, ChatGPT and plugin skills</th><th>Connection</th></tr></thead>
            <tbody>
              {STAGES.map((s) => {
                const u = STAGE_USES[s.no];
                return (
                  <tr key={s.no}>
                    <td style={{ whiteSpace: "nowrap" }}><strong>{s.no}. {s.name}</strong></td>
                    <td style={{ fontSize: 13 }}>{u.tools}</td>
                    <td style={{ fontSize: 13 }}>{u.ai}</td>
                    <td style={{ minWidth: 260 }}>
                      {!u.flow ? <span className="muted">None needed</span>
                        : u.flow === "execution" ? <span className="muted" style={{ fontSize: 13 }}>Chosen on the AC Check page: Claude in Chrome, or a Chrome window of its own for local addresses.</span>
                        : <EnginePicker flow={u.flow} back="/settings" />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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
            <label><span>MCP server URL</span><input name="BUG_MCP_URL" defaultValue={mcpUrl} placeholder="https://qa.yourcompany.com/mcp" disabled={!admin} /></label>
            {secretField("BUG_MCP_TOKEN", "Bearer token (optional)", hasMcpToken)}
          </div>
          <div><button type="submit" disabled={!admin}>Save and connect</button> {mcpTools.length > 0 && <Badge tone="ok">Connected, {mcpTools.length} tools</Badge>}</div>
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

      <h2 id="targets">Allowed test targets</h2>
      <div className="card" style={{ marginBottom: "1rem" }}>
        <p className="muted">Every run opens the URL to test or the API base from this server&apos;s network, so only the hosts listed here can be tested. One per line: <code>qa.example.com</code> (any port), <code>qa.example.com:8443</code>, or <code>*.staging.example.com</code>. Cloud metadata and link-local addresses are always refused. With the list empty, nothing can be tested.</p>
        {notAllowed.length > 0 && <p className="notice warn">In use but not allowed, so their runs will fail: {notAllowed.map((h) => <code key={h} style={{ marginRight: ".4rem" }}>{h}</code>)}</p>}
        <form action={saveTargets} className="stack">
          <textarea name="TARGET_ALLOWLIST" defaultValue={targets.join("\n")} className="mono" style={{ minHeight: "6rem" }} disabled={!admin} placeholder={"qa.example.com\n*.staging.example.com\nlocalhost:3000"} />
          <div><button type="submit" disabled={!admin}>Save allowed targets</button>{!admin && <span className="muted"> Only an Admin can change this.</span>}</div>
        </form>
      </div>

      <div className="grid-2">
        <div className="card">
          <h3>Other integrations</h3>
          <form action={saveSettings} className="stack">
            {!admin && <p className="notice info" style={{ margin: 0 }}>Only an Admin can change integrations.</p>}
            <label><span>Bug webhook URL (accepts JSON POST; used when Bug logging is set to Webhook)</span><input name="BUG_WEBHOOK_URL" defaultValue={url} placeholder="https://qa.yourcompany.com/api/bugs" disabled={!admin} /></label>
            {secretField("BUG_WEBHOOK_TOKEN", "Bug webhook bearer token (optional)", hasToken)}
            {secretField("IMPORT_TOKEN", "Import token for /api/import/* (required for CI imports, 16+ characters, sent as X-Import-Token)", hasImportToken)}
            {!hasImportToken && <p className="muted" style={{ margin: 0 }}>CI imports are off until this is set.</p>}
            <div><button type="submit" disabled={!admin}>Save</button></div>
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
