"use client";

import { useEffect, useRef, useState } from "react";
import { browserClient } from "@/lib/supabase";

/**
 * Subscribe to INSERT/UPDATE/DELETE on a Supabase table and call `onChange`.
 * Falls back silently if realtime can't connect (the caller should also
 * poll). Returns the current connection state for a UI indicator.
 */
export function useRealtime(
  table: string,
  onChange: () => void,
): "connecting" | "live" | "polling" {
  const [state, setState] = useState<"connecting" | "live" | "polling">("connecting");
  const cb = useRef(onChange);
  cb.current = onChange;

  useEffect(() => {
    let channel: ReturnType<ReturnType<typeof browserClient>["channel"]> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    try {
      const sb = browserClient();
      channel = sb
        .channel(`rt-${table}`)
        .on("postgres_changes", { event: "*", schema: "public", table }, () => cb.current())
        .subscribe((status) => {
          if (status === "SUBSCRIBED") setState("live");
          else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            setState("polling");
            if (!pollTimer) pollTimer = setInterval(() => cb.current(), 2500);
          }
        });
    } catch {
      setState("polling");
      pollTimer = setInterval(() => cb.current(), 2500);
    }

    // Safety-net poll even when "live" — cheap, keeps the demo robust.
    const safety = setInterval(() => cb.current(), 8000);

    return () => {
      if (channel) channel.unsubscribe();
      if (pollTimer) clearInterval(pollTimer);
      clearInterval(safety);
    };
  }, [table]);

  return state;
}
