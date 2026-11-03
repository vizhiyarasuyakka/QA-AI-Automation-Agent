"use client";

import type { ComponentProps } from "react";
import { useFormStatus } from "react-dom";

/** A submit button for something that cannot be undone: it asks first, then shows that it is working. Other buttons in the same form do not trigger its busy text. */
export function ConfirmButton({ message, busy = "Deleting...", children, disabled, ...props }: ComponentProps<"button"> & { message: string; busy?: string }) {
  const { pending, action, data } = useFormStatus();
  const mine = pending && (props.formAction ? action === props.formAction : !props.name || data?.get(props.name) === props.value);
  return (
    <button {...props} type="submit" disabled={disabled || pending} onClick={(e) => { if (!window.confirm(message)) e.preventDefault(); }}>
      {mine ? busy : children}
    </button>
  );
}
