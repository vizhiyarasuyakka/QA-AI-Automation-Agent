"use client";

/** Tick or untick every checkbox of one group. */
export function SelectGroup({ group, label, field = "execId" }: { group: string; label: string; field?: string }) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      onChange={(e) => document.querySelectorAll<HTMLInputElement>(`input[name="${field}"]`).forEach((box) => { if (box.dataset.group === group) box.checked = e.target.checked; })}
    />
  );
}
