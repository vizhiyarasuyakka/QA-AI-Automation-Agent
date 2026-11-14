import { atLeast, audit, currentUser } from "@/lib/auth";
import { requestCancel } from "@/lib/jobs";

export const dynamic = "force-dynamic";

/** Asks a running job to stop. QA Engineer and above; the job stops at its next step and keeps what it finished. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; jid: string }> }) {
  const { id, jid } = await params;
  const back = (() => {
    try {
      const ref = new URL(req.headers.get("referer") ?? "");
      if (ref.host === new URL(req.url).host) return ref.pathname;
    } catch {}
    return `/releases/${id}`;
  })();
  const to = (kind: "ok" | "err", m: string) => Response.redirect(new URL(`${back}?${kind}=${encodeURIComponent(m)}`, req.url), 303);

  const user = await currentUser();
  if (!user) return Response.redirect(new URL("/login", req.url), 303);
  if (!atLeast(user.role, "QA Engineer")) return to("err", "Only a QA Engineer or above can cancel a run.");
  const job = await requestCancel(jid, user.name);
  if (!job || job.releaseId !== id) return to("err", "That run has already finished.");
  await audit(user, "job.cancel", { releaseId: id, target: job.kind, detail: jid });
  return to("ok", "Cancelling. The run stops at its next step and keeps what it finished.");
}
