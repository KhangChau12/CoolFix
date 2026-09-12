"use client";

import { useEffect, useState, type ReactNode } from "react";
import { apiGet } from "@/lib/client";
import { configureClock } from "@/lib/time";
import type { RuntimeConfig } from "@/lib/types";

const CLOCK_STORAGE_KEY = "coolfix-runtime-clock";

/** Loads the persisted scheduling clock for browser-side date calculations. */
export default function ClockSync({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void apiGet<{ config: RuntimeConfig }>("/api/config")
      .then(({ config }) => {
        configureClock(config);
        try {
          window.localStorage.setItem(
            CLOCK_STORAGE_KEY,
            JSON.stringify({ clockMode: config.clockMode, customTimeISO: config.customTimeISO }),
          );
        } catch {
          // Browser storage is only an optimization; server persistence remains authoritative.
        }
      })
      .catch(() => {
        // Pages continue using real time if the configuration endpoint is unavailable.
      })
      .finally(() => {
        setReady(true);
      });
  }, []);

  if (!ready) {
    return <div style={{ minHeight: "100vh", background: "var(--bg)" }} />;
  }
  return <>{children}</>;
}
