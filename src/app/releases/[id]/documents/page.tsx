import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ReleaseNav } from "@/components/ReleaseNav";
import { Notice } from "@/components/Notice";
import { Badge } from "@/components/Badge";
import { ACCEPT } from "@/lib/documents";
import { filesState } from "@/lib/flows";
import { deleteDocument, uploadDocuments } from "./actions";

export const dynamic = "force-dynamic";

const TYPES = ["PRD", "User stories", "Prototype", "Module fields", "Other"];

export default async function DocumentsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; err?: string; info?: string; type?: string; module?: string }> }) {
  const { id } = await params; const sp = await searchParams;
  const release = await prisma.release.findUnique({ where: { id } });
  if (!release) notFound();
  const [state, docs, protos] = await Promise.all([
    filesState(id),
    prisma.document.findMany({ where: { releaseId: id }, orderBy: [{ module: "asc" }, { fileName: "asc" }] }),
    prisma.prototype.findMany({ where: { releaseId: id }, orderBy: [{ module: "asc" }, { fileName: "asc" }], select: { id: true, fileName: true, module: true, sizeBytes: true } }),
  ]);

  const files = [
    ...docs.map((d) => ({ id: d.id, kind: "document", fileName: d.fileName, type: d.docType, module: d.module, size: d.sizeBytes, chars: d.text.length as number | null, status: d.status, error: d.error, text: d.text })),
    ...protos.map((p) => ({ id: p.id, kind: "prototype", fileName: p.fileName, type: "Prototype", module: p.module, size: p.sizeBytes, chars: null as number | null, status: "Ready", error: "", text: "" })),
  ].sort((a, b) => TYPES.indexOf(a.type) - TYPES.indexOf(b.type) || a.module.localeCompare(b.module) || a.fileName.localeCompare(b.fileName));
  const modules = [...new Set(files.map((f) => f.module).filter(Boolean))].sort();
  const shown = files.filter((f) => (!sp.type || f.type === sp.type) && (sp.module === undefined || f.module === sp.module));
  const back = `/releases/${id}/documents`;
  const link = (q: { type?: string; module?: string }) => {
    const p = new URLSearchParams();
    if (q.type) p.set("type", q.type);
    if (q.module !== undefined) p.set("module", q.module);
    const s = p.toString();
    return s ? `${back}?${s}` : back;
  };

  return (
    <>
      <h1>{release.name}: PRD and documents</h1>
      <p className="muted">Step 1. Keep the PRD, user stories, prototype and module fields here, module by module. Step 2 reads them to write the test cases.</p>
      <ReleaseNav releaseId={id} active="documents" />
      <Notice searchParams={sp} />

      <div className="card" style={{ marginBottom: "1rem" }}>
        <div className="row spread"><strong>Step 1 status</strong><Badge tone={state.tone}>{state.status}</Badge></div>
        <p className="muted" style={{ margin: ".4rem 0 0" }}>{state.detail}{state.complete && <> <Link href={`/releases/${id}/stories`}>Go to test cases</Link>.</>}</p>
      </div>

      <div className="card" style={{ marginBottom: "1rem" }}>
        <h3>All files ({files.length})</h3>
        <form action={uploadDocuments} className="row" style={{ marginBottom: ".75rem" }}>
          <input type="hidden" name="releaseId" value={id} />
          <input type="file" name="files" multiple accept={ACCEPT} required aria-label="Files" style={{ maxWidth: 300 }} />
          <select name="docType" defaultValue="PRD" aria-label="File type" style={{ width: "auto" }}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select>
          <input name="module" list="modules" placeholder="Module (blank = whole release)" aria-label="Module" style={{ maxWidth: 240 }} />
          <datalist id="modules">{modules.map((m) => <option key={m} value={m} />)}</datalist>
          <button type="submit">Add files</button>
        </form>
        <p className="muted" style={{ fontSize: "12px" }}>PDF, DOCX, XLSX, CSV, TXT, MD. Prototype screens can also be PNG, JPG, WEBP, GIF, SVG or HTML, one file per screen. The same file name and module replaces the old copy.</p>

        <div className="row" style={{ margin: ".5rem 0" }}>
          <a className={`btn small ${!sp.type ? "" : "secondary"}`} href={link({ module: sp.module })}>All types</a>
          {TYPES.map((t) => {
            const n = files.filter((f) => f.type === t).length;
            return <a key={t} className={`btn small ${sp.type === t ? "" : "secondary"}`} href={link({ type: t, module: sp.module })}>{t} {n}</a>;
          })}
        </div>
        {modules.length > 0 && (
          <div className="row" style={{ marginBottom: ".5rem" }}>
            <a className={`btn small ${sp.module === undefined ? "" : "secondary"}`} href={link({ type: sp.type })}>All modules</a>
            <a className={`btn small ${sp.module === "" ? "" : "secondary"}`} href={link({ type: sp.type, module: "" })}>Whole release</a>
            {modules.map((m) => <a key={m} className={`btn small ${sp.module === m ? "" : "secondary"}`} href={link({ type: sp.type, module: m })}>{m}</a>)}
          </div>
        )}

        <div className="tbox">
          <table>
            <thead><tr><th>File</th><th>Type</th><th>Module</th><th className="num">Size</th><th className="num">Text read</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {shown.map((f) => (
                <tr key={`${f.kind}-${f.id}`}>
                  <td style={{ overflowWrap: "anywhere", minWidth: 220 }}>
                    {f.kind === "prototype"
                      ? <a href={`/releases/${id}/ui-testing/prototype/${f.id}`} target="_blank" rel="noreferrer">{f.fileName}</a>
                      : f.fileName}
                    {f.kind === "document" && f.status === "Ready" && <details><summary className="muted">View extracted text</summary><pre className="block" style={{ maxHeight: "16rem", overflow: "auto", whiteSpace: "pre-wrap" }}>{f.text}</pre></details>}
                    {f.error && <div className="muted">{f.error}</div>}
                  </td>
                  <td>{f.type}</td>
                  <td>{f.module || <span className="muted">Whole release</span>}</td>
                  <td className="num">{f.size ? `${Math.max(1, Math.round(f.size / 1024))} KB` : <span className="muted">-</span>}</td>
                  <td className="num">{f.chars === null ? <span className="muted">Read as a picture</span> : `${f.chars.toLocaleString("en-IN")} chars`}</td>
                  <td><Badge tone={f.status === "Ready" ? "ok" : "bad"}>{f.status}</Badge></td>
                  <td><form action={deleteDocument} className="inline-form"><input type="hidden" name="id" value={f.id} /><input type="hidden" name="kind" value={f.kind} /><input type="hidden" name="releaseId" value={id} /><button className="small secondary">Remove</button></form></td>
                </tr>
              ))}
              {!shown.length && <tr><td colSpan={7} className="muted">{files.length ? "No files match this filter." : "Nothing added yet. Start with the PRD."}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
