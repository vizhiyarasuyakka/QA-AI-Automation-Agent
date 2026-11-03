export function Badge({ children, tone }: { children: React.ReactNode; tone?: "ok" | "warn" | "bad" | "accent" }) {
  return <span className={`badge ${tone ?? ""}`}>{children}</span>;
}
export function severityTone(s: string): "ok" | "warn" | "bad" | "accent" | undefined {
  return s === "Critical" || s === "High" ? "bad" : s === "Medium" ? "warn" : undefined;
}
export function resultTone(r: string): "ok" | "warn" | "bad" | "accent" | undefined {
  return r === "Pass" ? "ok" : r === "Fail" ? "bad" : r === "Blocked" ? "warn" : undefined;
}
export function statusTone(s: string): "ok" | "warn" | "bad" | "accent" | undefined {
  return s === "Done" || s === "Fixed" || s === "Closed" ? "ok" : s === "In progress" || s === "Reopened" ? "warn" : s === "Failed" ? "bad" : undefined;
}
