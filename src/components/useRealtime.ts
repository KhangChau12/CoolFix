"use client";

import { useEffect, useRef, useState } from "react";
import { browserClient } from "@/lib/supabase";

let subscriptionId = 0;

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
    let active = true;
    let channel: ReturnType<ReturnType<typeof browserClient>["channel"]> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    setState("connecting");

    try {
      const sb = browserClient();
      channel = sb
        // Supabase leaves an existing channel when another joins its topic.
        // The flow page and map both observe decisions, so each effect needs
        // its own topic, including Strict Mode's setup/cleanup/setup cycle.
        .channel(`rt-${table}-${++subscriptionId}`)
        .on("postgres_changes", { event: "*", schema: "public", table }, () => {
          if (active) cb.current();
        })
        .subscribe((status) => {
          if (!active) return;
          if (status === "SUBSCRIBED") {
            setState("live");
            if (pollTimer) clearInterval(pollTimer);
            pollTimer = null;
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
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
      active = false;
      if (channel) channel.unsubscribe();
      if (pollTimer) clearInterval(pollTimer);
      clearInterval(safety);
    };
  }, [table]);

  return state;
}
