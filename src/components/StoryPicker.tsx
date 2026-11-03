"use client";

import { useEffect, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";
import { ConfirmButton } from "./ConfirmButton";

export type PickableStory = { id: string; storyId: string; title: string; sourceFile: string; cases: number };
export type PickablePrd = { id: string; fileName: string; module: string; chars: number };

const BY_HAND = "Added by hand";

/** Choose what to write cases for: one row per user stories file, with its stories inside. A PRD is optional. Nothing is ticked at first, so a run is always a decision. */
export function StoryPicker({ releaseId, started, stories, prds, disabled, disabledNote, deleteAction }: { releaseId: string; started: boolean; stories: PickableStory[]; prds: PickablePrd[]; disabled: boolean; disabledNote?: string; deleteAction: (formData: FormData) => Promise<void> }) {
  const { pending, action } = useFormStatus();
  const starting = pending && action !== deleteAction;
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pickedPrds, setPickedPrds] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const key = `qa-picked-${releaseId}`;
  const prdKey = `qa-picked-prds-${releaseId}`;

  // The page reloads when the server refuses a run, so the selection is kept until a run actually starts.
  useEffect(() => {
    try {
      if (started) {
        sessionStorage.removeItem(key);
        sessionStorage.removeItem(prdKey);
      } else {
        const known = new Set(stories.map((s) => s.id));
        setPicked(new Set((JSON.parse(sessionStorage.getItem(key) ?? "[]") as string[]).filter((id) => known.has(id))));
        const knownPrds = new Set(prds.map((p) => p.id));
        setPickedPrds(new Set((JSON.parse(sessionStorage.getItem(prdKey) ?? "[]") as string[]).filter((id) => knownPrds.has(id))));
      }
    } catch {}
    // Runs once per page load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const remember = (next: Set<string>) => {
    setPicked(next);
    try {
      sessionStorage.setItem(key, JSON.stringify([...next]));
    } catch {}
  };
  const togglePrd = (id: string, on: boolean) => {
    const next = new Set(pickedPrds);
    if (on) next.add(id);
    else next.delete(id);
    setPickedPrds(next);
    try {
      sessionStorage.setItem(prdKey, JSON.stringify([...next]));
    } catch {}
  };

  // Deleted stories leave the selection, so the counts and the next run stay honest.
  useEffect(() => {
    const known = new Set(stories.map((s) => s.id));
    setPicked((now) => {
      const kept = [...now].filter((id) => known.has(id));
      if (kept.length === now.size) return now;
      try {
        sessionStorage.setItem(key, JSON.stringify(kept));
      } catch {}
      return new Set(kept);
    });
  }, [stories, key]);

  const files = useMemo(() => {
    const groups = new Map<string, PickableStory[]>();
    for (const s of stories) {
      const file = s.sourceFile || BY_HAND;
      groups.set(file, [...(groups.get(file) ?? []), s]);
    }
    return [...groups.entries()].sort(([a], [b]) => (a === BY_HAND ? 1 : b === BY_HAND ? -1 : a.localeCompare(b)));
  }, [stories]);

  const q = query.trim().toLowerCase();
  const matches = (s: PickableStory) => !q || `${s.storyId} ${s.title} ${s.sourceFile}`.toLowerCase().includes(q);
  const visible = stories.filter(matches);

  const set = (ids: string[], on: boolean) => {
    const next = new Set(picked);
    ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
    remember(next);
  };

  return (
    <>
      <div className="row spread" style={{ marginBottom: ".5rem" }}>
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a story" aria-label="Find a story" style={{ maxWidth: 280 }} />
        <div className="row">
          <span className="muted">{picked.size} of {stories.length} stories selected</span>
          <button type="button" className="small secondary" onClick={() => set(visible.map((s) => s.id), true)} disabled={!visible.length}>{q ? "Select these" : "Select all"}</button>
          <button type="button" className="small secondary" onClick={() => remember(new Set())} disabled={!picked.size}>Clear</button>
          <ConfirmButton
            className="small danger"
            formAction={deleteAction}
            disabled={!picked.size}
            message={`Delete ${picked.size} ${picked.size === 1 ? "story" : "stories"} and their ${stories.filter((s) => picked.has(s.id)).reduce((a, s) => a + s.cases, 0)} test cases? This cannot be undone.`}
          >
            Delete selected
          </ConfirmButton>
        </div>
      </div>

      <div className="picker" role="group" aria-label="User stories to generate">
        {files.map(([file, list]) => {
          const shown = list.filter(matches);
          if (!shown.length) return null;
          const count = list.filter((s) => picked.has(s.id)).length;
          return (
            <fieldset key={file} className="picker-module">
              <legend>
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={count === list.length}
                    ref={(el) => { if (el) el.indeterminate = count > 0 && count < list.length; }}
                    onChange={(e) => set(list.map((s) => s.id), e.target.checked)}
                  />
                  <strong style={{ overflowWrap: "anywhere" }}>{file}</strong>
                  <span className="muted">{count} of {list.length} selected</span>
                </label>
              </legend>
              {/* Closed stories still submit, so ticking the file selects everything in it. */}
              <details open={q ? true : undefined}>
                <summary className="muted" style={{ fontSize: "12px", paddingLeft: "1.4rem" }}>The {list.length === 1 ? "story" : `${list.length} stories`} in this file</summary>
                {shown.map((s) => (
                  <label key={s.id} className="inline picker-story">
                    <input type="checkbox" name="story" value={s.id} checked={picked.has(s.id)} onChange={(e) => set([s.id], e.target.checked)} />
                    <span className="picker-title"><strong>{s.storyId}</strong> {s.title}</span>
                    <span className="muted picker-meta">{s.cases ? `${s.cases} cases` : "No cases yet"}</span>
                  </label>
                ))}
              </details>
            </fieldset>
          );
        })}
        {!stories.length && <p className="muted" style={{ margin: 0 }}>No user stories yet. Load them from your file above, or add one by hand below.</p>}
        {stories.length > 0 && !visible.length && <p className="muted" style={{ margin: 0 }}>No story matches that search.</p>}
      </div>

      {/* A ticked story hidden by the search still submits, so keep it in the form. */}
      {stories.filter((s) => picked.has(s.id) && !matches(s)).map((s) => <input key={s.id} type="hidden" name="story" value={s.id} />)}

      {prds.length > 0 && (
        <div style={{ marginTop: "1rem" }}>
          <strong>PRD to read as well</strong> <span className="muted">Optional. A ticked PRD goes to Claude with every selected story, so it uses more of your plan.</span>
          <div className="tbox" style={{ maxHeight: "12rem", marginTop: ".4rem" }}>
            <table>
              <thead><tr><th>Use</th><th>PRD</th><th>Module</th><th className="num">Size</th></tr></thead>
              <tbody>
                {prds.map((p) => (
                  <tr key={p.id}>
                    <td><input type="checkbox" name="prd" value={p.id} checked={pickedPrds.has(p.id)} onChange={(e) => togglePrd(p.id, e.target.checked)} aria-label={`Use ${p.fileName}`} /></td>
                    <td style={{ overflowWrap: "anywhere" }}>{p.fileName}</td>
                    <td>{p.module || <span className="muted">Whole release</span>}</td>
                    <td className="num">{p.chars.toLocaleString("en-IN")} chars</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div style={{ marginTop: ".75rem" }}>
        <button type="submit" disabled={disabled || !picked.size || pending}>{starting ? <><span className="spinner small" aria-hidden="true" /> Starting...</> : `Generate test cases and test data${picked.size ? ` for ${picked.size} ${picked.size === 1 ? "story" : "stories"}` : ""}`}</button>
        <span className="muted" style={{ marginLeft: ".6rem" }}>{disabledNote ?? (!picked.size ? "Select a user stories file, or stories inside it." : "")}</span>
      </div>
    </>
  );
}
