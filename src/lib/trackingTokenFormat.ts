// ── Tracking token format (client-safe) ─────────────────────────────
// Pure string helpers with no Node dependency, so this file can be
// imported from client components (the "Track My Service" entry form)
// without pulling `node:crypto` into the browser bundle. Generation
// itself (`generateTrackingToken`, which needs real randomness) lives in
// `trackingToken.ts` and is server-only.

const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // 32 symbols, 5 bits each
export const TRACKING_TOKEN_GROUPS = 3;
export const TRACKING_TOKEN_GROUP_LEN = 4;
export const TRACKING_TOKEN_PREFIX = "CF";
export const TRACKING_TOKEN_ALPHABET = ALPHABET;

const TOKEN_SHAPE = new RegExp(
  `^${TRACKING_TOKEN_PREFIX}(-[${ALPHABET}]{${TRACKING_TOKEN_GROUP_LEN}}){${TRACKING_TOKEN_GROUPS}}$`,
);

/**
 * Cheap shape check before ever touching the database — rejects garbage
 * (wrong length, lowercase, a raw job_id like "job_abc123") without a
 * round-trip, and without revealing anything about which shapes are
 * "closer" to a real token.
 */
export function isValidTrackingTokenFormat(token: string): boolean {
  return TOKEN_SHAPE.test(token);
}

/** Normalise user-typed input (the "Track My Service" form): trim,
 *  uppercase, tolerate missing dashes / extra spaces. */
export function normalizeTrackingTokenInput(raw: string): string {
  const cleaned = raw.trim().toUpperCase().replace(/\s+/g, "");
  const noPrefix = cleaned.startsWith(`${TRACKING_TOKEN_PREFIX}-`) || cleaned.startsWith(TRACKING_TOKEN_PREFIX)
    ? cleaned.replace(new RegExp(`^${TRACKING_TOKEN_PREFIX}-?`), "")
    : cleaned;
  const alnum = noPrefix.replace(/[^A-Z0-9]/g, "");
  if (alnum.length !== TRACKING_TOKEN_GROUPS * TRACKING_TOKEN_GROUP_LEN) return cleaned; // let format check reject it
  const groups: string[] = [];
  for (let g = 0; g < TRACKING_TOKEN_GROUPS; g++) {
    groups.push(alnum.slice(g * TRACKING_TOKEN_GROUP_LEN, (g + 1) * TRACKING_TOKEN_GROUP_LEN));
  }
  return `${TRACKING_TOKEN_PREFIX}-${groups.join("-")}`;
}
