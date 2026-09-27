"use client";

import { useEffect, type ReactNode } from "react";

const CLOCK_STORAGE_KEY = "coolfix-runtime-clock";

/** Remove the retired browser override without delaying page rendering. */
export default function ClockSync({ children }: { children: ReactNode }) {
  useEffect(() => {
    try {
      window.localStorage.removeItem(CLOCK_STORAGE_KEY);
    } catch {
      // Time calculations never read storage, including when it is blocked.
    }
  }, []);
  return <>{children}</>;
}
