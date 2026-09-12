// ── Customer feedback validation ────────────────────────────────────
// The one gate all untrusted feedback input passes through before it ever
// reaches the database. Mirrors the style of agents/schemas.ts
// (validateBookingRequest): a pure function, no I/O, that turns "unknown
// JSON from the internet" into a narrow, safe shape — or a typed error the
// route can turn into a generic customer-facing message.
//
// What this deliberately does NOT do: decide whether the *job* is eligible
// for feedback (completed, has a technician, no existing feedback) — that
// depends on server-side state the client must never influence, and lives
// in the API route right next to the tracking-token lookup instead.

import {
  FEEDBACK_COMMENT_MAX_LEN,
  FEEDBACK_IMPROVEMENT_TAGS,
  FEEDBACK_POSITIVE_TAGS,
  type FeedbackImprovementTag,
  type FeedbackPositiveTag,
} from "./types";

export interface FeedbackSubmission {
  rating: number;
  positive_tags: FeedbackPositiveTag[];
  improvement_tags: FeedbackImprovementTag[];
  comment: string | null;
}

export type FeedbackValidationError =
  | "invalid_payload"
  | "invalid_rating"
  | "invalid_tags"
  | "comment_too_long";

export type FeedbackValidationResult =
  | { ok: true; value: FeedbackSubmission }
  | { ok: false; error: FeedbackValidationError };

export function validateFeedbackSubmission(raw: unknown): FeedbackValidationResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "invalid_payload" };
  }
  const b = raw as Record<string, unknown>;

  // Integer 1–5 only. Must actually BE a number — a numeric-looking string
  // like "5" is rejected rather than silently coerced, same as any other
  // type-confused input.
  if (typeof b.rating !== "number" || !Number.isInteger(b.rating) || b.rating < 1 || b.rating > 5) {
    return { ok: false, error: "invalid_rating" };
  }
  const rating = b.rating;

  const positive_tags = sanitizeTags(b.positive_tags, FEEDBACK_POSITIVE_TAGS);
  if (positive_tags === null) return { ok: false, error: "invalid_tags" };
  const improvement_tags = sanitizeTags(b.improvement_tags, FEEDBACK_IMPROVEMENT_TAGS);
  if (improvement_tags === null) return { ok: false, error: "invalid_tags" };

  let comment: string | null = null;
  if (b.comment !== undefined && b.comment !== null) {
    if (typeof b.comment !== "string") return { ok: false, error: "invalid_payload" };
    if (b.comment.length > FEEDBACK_COMMENT_MAX_LEN) return { ok: false, error: "comment_too_long" };
    // Strip control characters (not visible-text sanitisation — React
    // already escapes on render — just cheap hygiene against stray bytes
    // making it into stored text / the admin feed). Free text stays free
    // text: it is stored and displayed verbatim otherwise, NEVER
    // interpolated into an agent/LLM prompt anywhere in this codebase.
    const cleaned = b.comment.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").trim();
    comment = cleaned.length > 0 ? cleaned : null;
  }

  return { ok: true, value: { rating, positive_tags, improvement_tags, comment } };
}

/** `undefined` → empty array (field omitted). Anything else must be an
 *  array of strings drawn only from `allowed` — one unknown/garbage entry
 *  rejects the whole submission rather than silently dropping it (an
 *  unrecognised tag is either a client bug or a probe; neither should be
 *  swallowed quietly). Deduplicated. */
function sanitizeTags<T extends string>(input: unknown, allowed: readonly T[]): T[] | null {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > allowed.length) return null;
  const set = new Set<T>();
  for (const v of input) {
    if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) return null;
    set.add(v as T);
  }
  return [...set];
}
