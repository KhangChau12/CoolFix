// ── Public tracking token — generation (server-only) ────────────────
// The access mechanism for the customer tracking experience (`/track/:token`,
// `GET /api/public/jobs/:token`). Generated server-side only, never derived
// from the job_id, never accepted from the client. Treat it as a bearer
// credential: whoever holds it can read that one job's customer-safe view.
//
// Format: "CF-XXXX-XXXX-XXXX" — 12 symbols over a 32-character alphabet
// (Crockford-style, drops 0/O/1/I/L to avoid transcription mistakes) =
// 60 bits of entropy from `crypto.randomBytes`, split into human-typeable
// groups. Long enough to be practically unguessable; short enough that the
// "Track My Service" fallback entry point (manual entry) stays usable.
//
// Uses `node:crypto`, so this module must only be imported from
// server-side code (agents, API routes, seed scripts) — never from a
// client component. Format validation / normalisation (safe to ship to
// the browser) lives in `./trackingTokenFormat`.

import { randomBytes } from "node:crypto";
import {
  TRACKING_TOKEN_ALPHABET,
  TRACKING_TOKEN_GROUPS,
  TRACKING_TOKEN_GROUP_LEN,
  TRACKING_TOKEN_PREFIX,
} from "./trackingTokenFormat";

export { isValidTrackingTokenFormat, normalizeTrackingTokenInput } from "./trackingTokenFormat";

/** `CF-XXXX-XXXX-XXXX`, all-uppercase, groups joined by "-". */
export function generateTrackingToken(): string {
  const bytes = randomBytes(TRACKING_TOKEN_GROUPS * TRACKING_TOKEN_GROUP_LEN);
  const symbols: string[] = [];
  for (const b of bytes) symbols.push(TRACKING_TOKEN_ALPHABET[b % TRACKING_TOKEN_ALPHABET.length]);
  const groups: string[] = [];
  for (let g = 0; g < TRACKING_TOKEN_GROUPS; g++) {
    groups.push(symbols.slice(g * TRACKING_TOKEN_GROUP_LEN, (g + 1) * TRACKING_TOKEN_GROUP_LEN).join(""));
  }
  return `${TRACKING_TOKEN_PREFIX}-${groups.join("-")}`;
}
