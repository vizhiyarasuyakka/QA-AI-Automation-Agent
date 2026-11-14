"use server";

import { engineOptions, refreshInventory, setEngine, type Flow } from "@/lib/engines";
import { mcpListTools, suggestArgs } from "@/lib/mcp";
import { audit, requireRole } from "@/lib/auth";
import { ALLOWLIST_KEY, parseAllowlist, patternProblem } from "@/lib/targets";
import { BUG_FIELDS, REPORT_FIELDS, getSetting, setSetting } from "@/lib/webhook";
import { redirect } from "next/navigation";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/** A secret field left blank keeps what is saved; its "clear" box removes it. Secrets are never sent back to the page. */
async function saveSecret(formData: FormData, key: string): Promise<string | null> {
  const value = s(formData, key);
  if (formData.get(`clear_${key}`) === "on") { await setSetting(key, ""); return "cleared"; }
  if (!value) return null;
  await setSetting(key, value);
  return "changed";
}

export async function saveSettings(formData: FormData) {
  const user = await requireRole("Admin", "change integrations");
  const importToken = s(formData, "IMPORT_TOKEN");
  if (importToken && importToken.length < 16) redirect(`/settings?err=${encodeURIComponent("The import token needs at least 16 characters.")}`);
  const changed: string[] = [];
  const url = s(formData, "BUG_WEBHOOK_URL");
  if (url !== (await getSetting("BUG_WEBHOOK_URL"))) { await setSetting("BUG_WEBHOOK_URL", url); changed.push("BUG_WEBHOOK_URL"); }
  for (const key of ["BUG_WEBHOOK_TOKEN", "IMPORT_TOKEN"]) {
    const how = await saveSecret(formData, key);
    if (how) changed.push(`${key} ${how}`);
  }
  if (changed.length) await audit(user, "settings.save", { detail: changed.join(", ") });
  redirect(`/settings?ok=${encodeURIComponent(changed.length ? `Saved: ${changed.join(", ")}` : "Nothing changed")}`);
}

/** The hosts this server may send test traffic to. One pattern per line; checked when saved and when each run starts. */
export async function saveTargets(formData: FormData) {
  const user = await requireRole("Admin", "change the allowed test targets");
  const patterns = parseAllowlist(String(formData.get(ALLOWLIST_KEY) ?? ""));
  const bad = patterns.map(patternProblem).filter(Boolean);
  if (bad.length) redirect(`/settings?err=${encodeURIComponent(`Not saved: ${bad.join("; ")}.`)}#targets`);
  const before = parseAllowlist(await getSetting(ALLOWLIST_KEY));
  await setSetting(ALLOWLIST_KEY, patterns.join("\n"));
  const added = patterns.filter((p) => !before.includes(p)), removed = before.filter((p) => !patterns.includes(p));
  await audit(user, "settings.targets", { detail: [added.length && `added ${added.join(", ")}`, removed.length && `removed ${removed.join(", ")}`].filter(Boolean).join("; ") || "unchanged" });
  redirect(`/settings?ok=${encodeURIComponent(`${patterns.length} allowed test target${patterns.length === 1 ? "" : "s"} saved`)}#targets`);
}

export async function saveEngine(formData: FormData) {
  const user = await requireRole("QA Lead", "choose the connection a step uses");
  const flow = s(formData, "flow") as Flow;
  const engine = s(formData, "engine");
  const back = s(formData, "back") || "/settings";
  const sep = back.includes("?") ? "&" : "?";
  const option = (await engineOptions(flow)).find((o) => o.id === engine);
  if (!option) redirect(`${back}${sep}err=${encodeURIComponent("That connection is not available.")}`);
  await setEngine(flow, engine);
  await audit(user, "settings.engine", { target: flow, detail: engine });
  redirect(`${back}${sep}${option.ok ? "ok" : "err"}=${encodeURIComponent(option.ok ? `Now using ${option.label}` : `${option.label} selected but not ready. ${option.detail}`)}`);
}

export async function recheckConnections() {
  refreshInventory();
  redirect("/settings?info=Checking connections again");
}

export async function saveReportTool(formData: FormData) {
  const user = await requireRole("Admin", "change integrations");
  const tool = s(formData, "REPORT_MCP_TOOL");
  const previous = await getSetting("REPORT_MCP_TOOL");
  let args = s(formData, "REPORT_MCP_ARGS");
  if (tool !== previous || !args) {
    const tools = JSON.parse((await getSetting("BUG_MCP_TOOLS")) || "[]");
    const found = tools.find((t: { name: string }) => t.name === tool);
    args = found ? suggestArgs(found, REPORT_FIELDS) : "{}";
  }
  try {
    JSON.parse(args);
  } catch {
    redirect(`/settings?err=${encodeURIComponent("The report argument template is not valid JSON.")}`);
  }
  await setSetting("REPORT_MCP_TOOL", tool);
  await setSetting("REPORT_MCP_ARGS", args);
  await audit(user, "settings.report_tool", { detail: tool || "cleared" });
  redirect(`/settings?ok=${encodeURIComponent(tool ? `Reports will call ${tool}. Check the arguments below.` : "Report tool cleared")}`);
}

/** Save the server details, connect, and offer the tools it actually exposes. */
export async function connectMcp(formData: FormData) {
  const user = await requireRole("Admin", "change integrations");
  const url = s(formData, "BUG_MCP_URL");
  await setSetting("BUG_MCP_URL", url);
  const how = await saveSecret(formData, "BUG_MCP_TOKEN");
  const token = await getSetting("BUG_MCP_TOKEN");
  await audit(user, "settings.mcp", { detail: `${url || "removed"}${how ? `; token ${how}` : ""}` });
  if (!url) {
    await setSetting("BUG_MCP_TOOLS", "");
    await setSetting("BUG_MCP_TOOL", "");
    redirect("/settings?ok=MCP connector removed");
  }
  let message: string;
  try {
    const tools = await mcpListTools(url, token);
    await setSetting("BUG_MCP_TOOLS", JSON.stringify(tools));
    message = `Connected. The server offers ${tools.length} tool${tools.length === 1 ? "" : "s"}.`;
  } catch (e) {
    await setSetting("BUG_MCP_TOOLS", "");
    redirect(`/settings?err=${encodeURIComponent(`Could not connect: ${(e instanceof Error ? e.message : String(e)).slice(0, 240)}`)}`);
  }
  redirect(`/settings?ok=${encodeURIComponent(message)}`);
}

export async function saveMcpTool(formData: FormData) {
  const user = await requireRole("Admin", "change integrations");
  const tool = s(formData, "BUG_MCP_TOOL");
  const previous = await getSetting("BUG_MCP_TOOL");
  let args = s(formData, "BUG_MCP_ARGS");
  if (tool !== previous || !args) {
    const tools = JSON.parse((await getSetting("BUG_MCP_TOOLS")) || "[]");
    const found = tools.find((t: { name: string }) => t.name === tool);
    args = found ? suggestArgs(found, BUG_FIELDS) : "{}";
  }
  try {
    JSON.parse(args);
  } catch {
    redirect(`/settings?err=${encodeURIComponent("The argument template is not valid JSON.")}`);
  }
  await setSetting("BUG_MCP_TOOL", tool);
  await setSetting("BUG_MCP_ARGS", args);
  await audit(user, "settings.bug_tool", { detail: tool });
  redirect(`/settings?ok=${encodeURIComponent(`Bugs will call ${tool}. Check the arguments below.`)}`);
}
