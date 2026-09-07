// ── Supabase clients ────────────────────────────────────────────────
// - `serviceClient()` : server-only, uses the service_role key, bypasses
//   RLS. Every agent write goes through this (in API routes / scripts).
// - `browserClient()` : anon key, read-only + realtime, safe to ship.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

let _service: SupabaseClient | null = null;
let _browser: SupabaseClient | null = null;

export function hasSupabaseEnv(): boolean {
  return Boolean(URL && ANON);
}

export function serviceClient(): SupabaseClient {
  if (typeof window !== "undefined") {
    throw new Error("serviceClient() must never run in the browser");
  }
  if (!URL || !SERVICE) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — see .env.example",
    );
  }
  if (!_service) {
    _service = createClient(URL, SERVICE, {
      auth: { persistSession: false, autoRefreshToken: false },
      // Next.js patches global fetch and caches responses inside route
      // handlers. Supabase makes its calls through that fetch, so without
      // this a table that was queried once (e.g. notifications, before any
      // row existed) keeps serving the stale empty result even though the
      // route is `dynamic`. Force every DB round-trip to bypass the cache.
      global: {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          fetch(input, { ...init, cache: "no-store" }),
      },
    });
  }
  return _service;
}

export function browserClient(): SupabaseClient {
  if (!URL || !ANON) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }
  if (!_browser) {
    _browser = createClient(URL, ANON, {
      auth: { persistSession: false },
      realtime: { params: { eventsPerSecond: 5 } },
    });
  }
  return _browser;
}
