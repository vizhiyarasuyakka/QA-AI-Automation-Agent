import { jobScope } from "./jobscope";
import { prisma } from "./prisma";

export type AiCallRecord = {
  via: "api" | "cli" | "cli-files" | "browser" | "chrome" | "codex";
  model?: string;
  skill?: string;
  ok: boolean;
  error?: string;
  ms: number;
  inputChars?: number;
  outputChars?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
};

/** Writes one row per model request, tagged with the job and release it ran for. Never fails the caller. */
export async function recordAiCall(r: AiCallRecord) {
  const s = jobScope.getStore();
  try {
    await prisma.aiCall.create({
      data: {
        releaseId: s?.releaseId ?? null, jobId: s?.jobId ?? null, kind: s?.kind ?? "", via: r.via, model: r.model ?? "", skill: r.skill ?? "",
        ok: r.ok, error: (r.error ?? "").slice(0, 500), ms: Math.round(r.ms), inputChars: r.inputChars ?? 0, outputChars: r.outputChars ?? 0,
        inputTokens: Math.round(r.inputTokens ?? 0), outputTokens: Math.round(r.outputTokens ?? 0), costUsd: r.costUsd ?? 0,
      },
    });
  } catch {
    // Usage tracking must never break a run.
  }
}

/** Claude Code's JSON result: usage and cost when it reports them. */
export function cliUsage(r: { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }; total_cost_usd?: number }) {
  const u = r.usage ?? {};
  return {
    inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
    costUsd: typeof r.total_cost_usd === "number" ? r.total_cost_usd : 0,
  };
}
