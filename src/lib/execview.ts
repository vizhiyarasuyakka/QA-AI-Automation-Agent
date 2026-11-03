import { parseCriteria, splitList } from "./coverage";

export type CriterionState = "No case" | "Not run" | "In progress" | "Blocked" | "Failed" | "Passed";
export type CriterionRow = { id: string; text: string; cases: number; passed: number; failed: number; state: CriterionState };

/** The PRDs a case traces to: the ones its source names, otherwise those covering its module. */
export function prdsForCase(c: { sourceRef: string; module: string }, prds: { fileName: string; module: string }[]): string[] {
  const named = prds.filter((p) => c.sourceRef.toLowerCase().includes(p.fileName.toLowerCase()));
  const list = named.length ? named : prds.filter((p) => !p.module.trim() || p.module.trim().toLowerCase() === c.module.trim().toLowerCase());
  return list.map((p) => p.fileName);
}

/** The planned executions that test the ticked criteria of a story. */
export function executionsForCriteria<E extends { id: string; testCase: { criteria: string } }>(execs: E[], criteria: string[]): E[] {
  const wanted = new Set(criteria.map((c) => c.toUpperCase()));
  return execs.filter((e) => splitList(e.testCase.criteria).some((c) => wanted.has(c.toUpperCase())));
}

/** A run of all the story's criteria, or of the one whose Run button was pressed. */
export function criteriaToRun(all: boolean, acceptanceCriteria: string, chosen: string[]): string[] {
  return all ? parseCriteria(acceptanceCriteria).map((c) => c.id) : chosen;
}

/** Where each acceptance criterion stands on a build, from the results of the cases tagged with it. */
export function criteriaStatus(acceptanceCriteria: string, rows: { criteria: string; result: string }[]): CriterionRow[] {
  return parseCriteria(acceptanceCriteria).map(({ id, text }) => {
    const mine = rows.filter((r) => splitList(r.criteria).some((x) => x.toUpperCase() === id));
    const passed = mine.filter((r) => r.result === "Pass").length;
    const failed = mine.filter((r) => r.result === "Fail").length;
    const blocked = mine.filter((r) => r.result === "Blocked").length;
    const state: CriterionState = !mine.length ? "No case" : failed ? "Failed" : blocked ? "Blocked" : passed === mine.length ? "Passed" : passed ? "In progress" : "Not run";
    return { id, text, cases: mine.length, passed, failed, state };
  });
}
