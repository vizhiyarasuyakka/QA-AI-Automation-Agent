"use client";

import type { ComponentProps } from "react";
import { useFormStatus } from "react-dom";

/** A submit button that says it is working while its own action runs, for actions that take a while. */
export function PendingButton({ busy, children, disabled, ...props }: ComponentProps<"button"> & { busy: string }) {
  const { pending, action } = useFormStatus();
  const mine = pending && (!props.formAction || action === props.formAction);
  return (
    <button {...props} type="submit" disabled={disabled || pending}>
      {mine ? <><span className="spinner small" aria-hidden="true" /> {busy}</> : children}
    </button>
  );
}
