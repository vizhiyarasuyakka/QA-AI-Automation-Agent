"use server";

import { engineOptions, refreshInventory, setEngine, type Flow } from "@/lib/engines";
import { mcpListTools, suggestArgs } from "@/lib/mcp";
import { BUG_FIELDS, REPORT_FIELDS, getSetting, setSetting } from "@/lib/webhook";
import { redirect } from "next/navigation";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

export async function saveSettings(formData: FormData) {
  for (const key of ["BUG_WEBHOOK_URL", "BUG_WEBHOOK_TOKEN", "IMPORT_TOKEN"]) {
    await setSetting(key, s(formData, key));
  }
  redirect("/settings?ok=Settings saved");
}

export async function saveEngine(formData: FormData) {
  const flow = s(formData, "flow") as Flow;
  const engine = s(formData, "engine");
  const back = s(formData, "back") || "/settings";
  const sep = back.includes("?") ? "&" : "?";
  const option = (await engineOptions(flow)).find((o) => o.id === engine);
  if (!option) redirect(`${back}${sep}err=${encodeURIComponent("That connection is not available.")}`);
  await setEngine(flow, engine);
  redirect(`${back}${sep}${option.ok ? "ok" : "err"}=${encodeURIComponent(option.ok ? `Now using ${option.label}` : `${option.label} selected but not ready. ${option.detail}`)}`);
}

export async function recheckConnections() {
  refreshInventory();
  redirect("/settings?info=Checking connections again");
}

export async function saveReportTool(formData: FormData) {
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
  redirect(`/settings?ok=${encodeURIComponent(tool ? `Reports will call ${tool}. Check the arguments below.` : "Report tool cleared")}`);
}

/** Save the server details, connect, and offer the tools it actually exposes. */
export async function connectMcp(formData: FormData) {
  const url = s(formData, "BUG_MCP_URL"), token = s(formData, "BUG_MCP_TOKEN");
  await setSetting("BUG_MCP_URL", url);
  await setSetting("BUG_MCP_TOKEN", token);
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
  redirect(`/settings?ok=${encodeURIComponent(`Bugs will call ${tool}. Check the arguments below.`)}`);
}
