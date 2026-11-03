export type Aspect = "behaviour" | "mandatory" | "minMax" | "format" | "default" | "dropdown";

export type CaseLike = { tcId: string; type: string; priority: string; criteria: string; covers: string };
export type RowLike = { field: string; mandatory: string; minMax: string; format: string; defaultV: string; dropdown: string; tcIds: string };
export type Gap = { kind: "intake" | "flow" | "criterion" | "field"; key: string; label: string };

const norm = (v: string) => v.trim().toLowerCase();
export const splitList = (v: string) => v.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);

export function criteriaLines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

const AC_PREFIX = /^AC\s*(\d+)\s*[:.)-]\s*(.+)$/i;

/** Criteria keep their number once given, so inserting or reordering lines never moves coverage onto another rule. */
export function parseCriteria(text: string): { id: string; text: string }[] {
  const lines = criteriaLines(text).map((l) => l.match(AC_PREFIX));
  let next = lines.reduce((m, hit) => Math.max(m, hit ? Number(hit[1]) : 0), 0) + 1;
  return criteriaLines(text).map((line, i) => {
    const hit = lines[i];
    return hit ? { id: `AC${Number(hit[1])}`, text: hit[2].trim() } : { id: `AC${next++}`, text: line };
  });
}

export const normalizeCriteria = (text: string) => parseCriteria(text).map((c) => `${c.id}: ${c.text}`).join("\n");

export function parseCovers(json: string): { field: string; aspect: string }[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function requiredAspects(r: RowLike): Aspect[] {
  const out: Aspect[] = ["behaviour"];
  if (r.mandatory.trim() && !/^(no|n|false|optional)$|^not\b/i.test(r.mandatory.trim())) out.push("mandatory");
  if (r.minMax.trim()) out.push("minMax");
  if (r.format.trim()) out.push("format");
  if (r.defaultV.trim()) out.push("default");
  if (r.dropdown.trim()) out.push("dropdown");
  return out;
}

/** A case only counts towards a rule its type can exercise: a Positive case cannot prove a mandatory check. */
function typeSatisfies(type: string, aspect: Aspect): boolean {
  if (aspect === "mandatory" || aspect === "format") return type === "Negative" || type === "Validation";
  if (aspect === "minMax") return type === "Boundary" || type === "Negative" || type === "Validation";
  return true;
}

/** What the documents require that no test case covers yet. Gate 2 and the generator both read this. */
export function coverageGaps(acceptanceCriteria: string, rows: RowLike[], cases: CaseLike[]): Gap[] {
  const lines = parseCriteria(acceptanceCriteria);
  if (!lines.length && !rows.length) return [{ kind: "intake", key: "intake", label: "No acceptance criteria or fields to cover" }];

  const gaps: Gap[] = [];
  if (!cases.some((c) => c.type === "Positive" && c.priority === "P1")) gaps.push({ kind: "flow", key: "flow", label: "No P1 positive case for the main flow" });

  for (const { id, text } of lines) {
    const hit = cases.some((c) => (c.priority === "P1" || c.priority === "P2") && splitList(c.criteria).some((x) => x.toUpperCase() === id));
    if (!hit) gaps.push({ kind: "criterion", key: id, label: `${id}: ${text}` });
  }

  for (const r of rows) {
    const listed = new Set(splitList(r.tcIds));
    for (const aspect of requiredAspects(r)) {
      const hit = cases.some((c) => {
        const tags = parseCovers(c.covers);
        if (typeSatisfies(c.type, aspect) && tags.some((t) => norm(t.field) === norm(r.field) && (aspect === "behaviour" || t.aspect === aspect))) return true;
        return !tags.length && listed.has(c.tcId) && typeSatisfies(c.type, aspect);
      });
      if (!hit) gaps.push({ kind: "field", key: `${r.field}|${aspect}`, label: `${r.field}: ${aspectLabel(aspect, r)}` });
    }
  }
  return gaps;
}

function aspectLabel(aspect: Aspect, r: RowLike): string {
  switch (aspect) {
    case "mandatory": return `mandatory check (${r.mandatory})`;
    case "minMax": return `min/max boundary (${r.minMax})`;
    case "format": return `format validation (${r.format})`;
    case "default": return `default value (${r.defaultV})`;
    case "dropdown": return `dropdown values (${r.dropdown})`;
    default: return "no case exercises this field";
  }
}
