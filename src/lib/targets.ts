import { isIP } from "node:net";
import { prisma } from "./prisma";
import { getSetting } from "./webhook";

/**
 * Where this server may send test traffic. Every browser run, API run and scan opens the URL to test or the API base
 * from its own network, so an open target would let anyone with an account use it to reach internal systems.
 * An Admin keeps one host pattern per line in Settings:
 *   qa.example.com           that host, any port
 *   qa.example.com:8443      that host and port only
 *   *.staging.example.com    any subdomain of staging.example.com
 * With no list saved, nothing is allowed. Cloud metadata and link-local addresses are refused whatever the list says.
 */
export const ALLOWLIST_KEY = "TARGET_ALLOWLIST";

export function parseAllowlist(text: string): string[] {
  return text.split(/[\r\n,]+/).map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith("#"));
}

/** A pattern that is not a host, host:port or *.domain. Null when it is fine. */
export function patternProblem(p: string): string | null {
  return /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/.test(p) || /^\[[0-9a-f:]+\](:\d{1,5})?$/.test(p)
    ? null
    : `"${p}" is not a host name, host:port or *.domain`;
}

const NEVER_HOSTS = new Set(["metadata.google.internal", "metadata", "instance-data"]);

/** Addresses no test ever needs: cloud instance metadata and link-local. */
export function neverAllowed(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (NEVER_HOSTS.has(h)) return true;
  if (isIP(h) === 4) return h.startsWith("169.254.") || h === "100.100.100.200" || h === "0.0.0.0";
  if (isIP(h) === 6) return /^fe[89ab][0-9a-f]:/.test(h) || h === "::" || h === "fd00:ec2::254";
  return false;
}

export function hostAllowed(raw: string, patterns: string[]): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (!["http:", "https:"].includes(url.protocol) || neverAllowed(url.hostname)) return false;
  const host = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return patterns.some((p) => {
    const [pHost, pPort] = p.startsWith("[") ? [p.slice(0, p.indexOf("]") + 1), p.slice(p.indexOf("]") + 2) || undefined] : p.split(":");
    if (pPort && pPort !== port) return false;
    const want = pHost.replace(/^\[|\]$/g, "");
    if (want.startsWith("*.")) return host.endsWith(want.slice(1)) && host.length > want.length - 1;
    return host === want;
  });
}

export async function allowlist(): Promise<string[]> {
  return parseAllowlist(await getSetting(ALLOWLIST_KEY));
}

/** Null when the server may test this address; otherwise what to tell the person. */
export async function targetProblem(raw: string, what = "The URL to test"): Promise<string | null> {
  let host = raw;
  try { host = new URL(raw).host; } catch { return `${what} is not a full web address.`; }
  try { if (neverAllowed(new URL(raw).hostname)) return `${what} points at a cloud metadata or link-local address, which is never tested.`; } catch {}
  const list = await allowlist();
  if (!list.length) return `${what} (${host}) cannot be used: no test targets are allowed yet. An Admin adds the hosts this server may test in Settings, Allowed test targets.`;
  return hostAllowed(raw, list) ? null : `${what} (${host}) is not an allowed test target. An Admin adds it in Settings, Allowed test targets.`;
}

const BUILD_KINDS = new Set(["criteria", "pw-run", "chrome", "security", "story-checks", "story-run", "ui-match", "ui-run"]);

/** Checked again when a run starts, so a target saved before the list existed, or removed from it since, does not run. */
export async function runTargetProblem(releaseId: string, kind: string): Promise<string | null> {
  if (kind === "api-run") {
    const t = await prisma.apiTarget.findUnique({ where: { releaseId }, select: { baseUrl: true } });
    return t?.baseUrl ? targetProblem(t.baseUrl, "The API base address") : null;
  }
  if (!BUILD_KINDS.has(kind)) return null;
  const build = await prisma.build.findFirst({ where: { releaseId }, orderBy: { deployedAt: "desc" }, select: { envUrl: true } });
  return build?.envUrl ? targetProblem(build.envUrl) : null;
}
