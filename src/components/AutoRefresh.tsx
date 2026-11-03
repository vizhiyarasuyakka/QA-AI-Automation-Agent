"use client";

import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";

/** Keeps a running job's page current without a reload, so ticked boxes and a click in progress survive. The next refresh waits for this one to finish. */
export function AutoRefresh({ seconds = 5 }: { seconds?: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  useEffect(() => {
    if (pending) return;
    const timer = setTimeout(() => start(() => router.refresh()), seconds * 1000);
    return () => clearTimeout(timer);
  }, [pending, router, seconds]);
  return null;
}
