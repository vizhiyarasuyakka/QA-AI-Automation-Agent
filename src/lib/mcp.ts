import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export type McpTool = { name: string; description?: string; inputSchema?: { properties?: Record<string, unknown>; required?: string[] } };

async function withClient<T>(url: string, token: string, use: (c: Client) => Promise<T>): Promise<T> {
  // Next's patched fetch keeps the server action open while these streaming responses are alive, so use the plain one.
  const plainFetch = (globalThis.fetch as typeof fetch & { _nextOriginalFetch?: typeof fetch })._nextOriginalFetch ?? globalThis.fetch;
  const transport = new StreamableHTTPClientTransport(new URL(url), { fetch: plainFetch, requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} } });
  const client = new Client({ name: "qa-workflow-app", version: "1.0.0" });
  await client.connect(transport);
  try {
    return await use(client);
  } finally {
    await client.close().catch(() => {});
  }
}

export function mcpListTools(url: string, token: string): Promise<McpTool[]> {
  return withClient(url, token, async (c) => (await c.listTools()).tools as McpTool[]);
}

/** Returns the tool's text output. A tool that reports isError throws, so the bug shows as failed. */
export function mcpCallTool(url: string, token: string, name: string, args: Record<string, unknown>): Promise<string> {
  return withClient(url, token, async (c) => {
    const res = await c.callTool({ name, arguments: args });
    const text = ((res.content as { type: string; text?: string }[] | undefined) ?? []).map((b) => b.text ?? "").join("\n");
    if (res.isError) throw new Error(text || `Tool ${name} reported an error.`);
    return text;
  });
}

const SYNONYMS: Record<string, string> = { summary: "title", name: "title", subject: "title", body: "description", details: "description", reproduction: "steps", stepstoreproduce: "steps", env: "environment", build: "buildNo", buildnumber: "buildNo", external_id: "bugId", externalid: "bugId", reference: "bugId", expectedresult: "expected", actualresult: "actual" };

/** A starting argument template: each tool parameter points at the bug field of the same or a similar name. */
export function suggestArgs(tool: McpTool, bugFields: string[]): string {
  const out: Record<string, string> = {};
  for (const key of Object.keys(tool.inputSchema?.properties ?? {})) {
    const k = key.toLowerCase().replace(/[-\s]/g, "");
    const field = bugFields.find((f) => f.toLowerCase() === k) ?? SYNONYMS[k] ?? SYNONYMS[key.toLowerCase()];
    if (field) out[key] = `{{${field}}}`;
  }
  return JSON.stringify(out, null, 2);
}

/** Fill {{field}} in a template. A value that is exactly one placeholder keeps its type, so booleans stay booleans. */
export function renderArgs(template: unknown, values: Record<string, unknown>): unknown {
  if (typeof template === "string") {
    const whole = template.match(/^\{\{(\w+)\}\}$/);
    if (whole) return values[whole[1]] ?? "";
    return template.replace(/\{\{(\w+)\}\}/g, (_, k) => String(values[k] ?? ""));
  }
  if (Array.isArray(template)) return template.map((t) => renderArgs(t, values));
  if (template && typeof template === "object") return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, renderArgs(v, values)]));
  return template;
}
