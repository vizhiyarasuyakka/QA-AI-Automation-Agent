import { saveEngine } from "@/app/settings/actions";
import { engineOptions, selectedEngine, type Flow } from "@/lib/engines";
import { Badge } from "./Badge";

/** Choose what does the work for one flow. Each flow keeps its own choice. */
export async function EnginePicker({ flow, back }: { flow: Flow; back: string }) {
  const [options, current] = await Promise.all([engineOptions(flow), selectedEngine(flow)]);
  const chosen = options.find((o) => o.id === current);
  const plain = options.filter((o) => !o.group);
  const grouped = options.filter((o) => o.group);
  return (
    <form action={saveEngine} className="stack" style={{ marginBottom: ".6rem" }}>
      <input type="hidden" name="flow" value={flow} /><input type="hidden" name="back" value={back} />
      <div className="row">
        <span className="muted">Connection:</span>
        <select name="engine" defaultValue={current} style={{ width: "auto", maxWidth: 320 }}>
          {plain.map((o) => <option key={o.id} value={o.id}>{o.label}{o.ok ? "" : " (not ready)"}</option>)}
          {grouped.length > 0 && <optgroup label={grouped[0].group}>{grouped.map((o) => <option key={o.id} value={o.id}>{o.label}{o.ok ? "" : " (not ready)"}</option>)}</optgroup>}
        </select>
        <button className="small secondary" type="submit">Use this</button>
        <Badge tone={chosen?.ok ? "ok" : "bad"}>{chosen?.ok ? "Ready" : "Not ready"}</Badge>
      </div>
      <span className="muted" style={{ fontSize: ".82rem" }}>{chosen?.detail ?? "This connection is no longer installed. Choose another."}</span>
    </form>
  );
}
