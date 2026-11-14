import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const LIMIT = 300;

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ action?: string }> }) {
  const sp = await searchParams;
  await requireRole("Admin", "read the audit log");
  const where = sp.action ? { action: { startsWith: sp.action } } : {};
  const [rows, releases] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: { at: "desc" }, take: LIMIT }),
    prisma.release.findMany({ select: { id: true, name: true } }),
  ]);
  const names = new Map(releases.map((r) => [r.id, r.name]));
  const filters = ["login", "signoff", "release", "script", "bug", "settings", "user", "stage"];

  return (
    <>
      <h1>Audit log</h1>
      <p className="muted">The latest {LIMIT} entries: who signed in, signed off, changed a release, edited a script, deleted something or changed a setting. Entries are never edited from the app.</p>
      <p className="row" style={{ gap: ".4rem", flexWrap: "wrap" }}>
        <Link href="/settings/audit" className={`btn small ${sp.action ? "secondary" : ""}`}>All</Link>
        {filters.map((f) => <Link key={f} href={`/settings/audit?action=${f}`} className={`btn small ${sp.action === f ? "" : "secondary"}`}>{f}</Link>)}
      </p>
      <div className="card">
        <div className="tbox">
          <table>
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Release</th><th>Target</th><th>Detail</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{r.at.toLocaleString("en-IN")}</td>
                  <td className="mono">{r.userEmail || "—"}</td>
                  <td className="mono">{r.action}</td>
                  <td>{r.releaseId ? <Link href={`/releases/${r.releaseId}`}>{names.get(r.releaseId) ?? "(deleted)"}</Link> : ""}</td>
                  <td>{r.target}</td>
                  <td className="muted" style={{ maxWidth: 420, overflowWrap: "anywhere" }}>{r.detail}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={6} className="muted">Nothing recorded yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
