import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { createRelease, deleteRelease } from "./actions";
import { Notice } from "@/components/Notice";
import { Badge } from "@/components/Badge";

export const dynamic = "force-dynamic";

export default async function ReleasesPage({ searchParams }: { searchParams: Promise<{ ok?: string; err?: string }> }) {
  const sp = await searchParams;
  const releases = await prisma.release.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { stories: true, bugs: true, builds: true } }, stages: true },
  });

  return (
    <>
      <h1>Releases</h1>
      <p className="muted">One release per sprint or version. Each release runs the 13-stage workflow with its own gates, executions, bugs and sign-off.</p>
      <Notice searchParams={sp} />
      <div className="card" style={{ marginBottom: "1rem" }}>
        <form action={createRelease} className="row">
          <input name="name" placeholder="Release name, e.g. Sprint 24 / v1.24" style={{ maxWidth: 360 }} required />
          <button type="submit">Create release</button>
        </form>
      </div>
      <div className="card">
        <table>
          <thead><tr><th>Release</th><th>Status</th><th className="num">Stages done</th><th className="num">Stories</th><th className="num">Builds</th><th className="num">Bugs</th><th className="num">Created</th><th></th></tr></thead>
          <tbody>
            {releases.map((r) => {
              const done = r.stages.filter((s) => s.status === "Done").length;
              return (
                <tr key={r.id}>
                  <td><Link href={`/releases/${r.id}`}><strong>{r.name}</strong></Link></td>
                  <td><Badge tone={r.status === "Released" ? "ok" : r.status === "Signed off" ? "accent" : undefined}>{r.status}</Badge></td>
                  <td className="num">{done} / 13</td>
                  <td className="num">{r._count.stories}</td>
                  <td className="num">{r._count.builds}</td>
                  <td className="num">{r._count.bugs}</td>
                  <td className="num">{r.createdAt.toLocaleDateString("en-IN")}</td>
                  <td>
                    <form action={deleteRelease} className="inline-form">
                      <input type="hidden" name="id" value={r.id} />
                      <button className="small secondary" type="submit">Delete</button>
                    </form>
                  </td>
                </tr>
              );
            })}
            {!releases.length && <tr><td colSpan={8} className="muted">No releases yet. Create one above.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
