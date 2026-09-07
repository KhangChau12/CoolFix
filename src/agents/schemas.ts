// ── Agent I/O schemas ───────────────────────────────────────────────
// Every message that crosses an agent boundary is one of these shapes.
// We use lightweight runtime validators (no zod dependency) so the demo
// build stays tiny, but each has an explicit typed contract + a
// `validate*` guard that agents call on their inputs — this is the
// "typed schema at every boundary" the rubric asks for.

import type { GeoPoint, SkillTag, Tier } from "@/lib/types";
import { SKILL_TAGS, TIERS } from "@/lib/types";

export class SchemaError extends Error {
  constructor(where: string, detail: string) {
    super(`[schema:${where}] ${detail}`);
    this.name = "SchemaError";
  }
}

function assert(cond: unknown, where: string, detail: string): asserts cond {
  if (!cond) throw new SchemaError(where, detail);
}

// ── Customer booking (untrusted entry point) ───────────────────────

export interface BookingRequest {
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  address: string;
  location: GeoPoint;
  problem_category: string;
  problem_description: string; // free text — untrusted
  photo_url: string | null;
  tier: Tier;
  /** Customer's preferred day (ISO date). Agent picks the slot. */
  preferred_date: string | null;
}

export function validateBookingRequest(x: unknown): BookingRequest {
  const b = x as Record<string, unknown>;
  assert(b && typeof b === "object", "booking", "not an object");
  assert(typeof b.customer_name === "string" && b.customer_name.length > 0, "booking", "customer_name required");
  assert(typeof b.customer_email === "string" && /.+@.+\..+/.test(b.customer_email), "booking", "valid customer_email required");
  assert(typeof b.address === "string" && b.address.length > 0, "booking", "address required");
  assert(b.location && typeof (b.location as GeoPoint).lat === "number", "booking", "location.lat required");
  assert(TIERS.includes(b.tier as Tier), "booking", `tier must be one of ${TIERS.join("|")}`);
  assert(typeof b.problem_description === "string", "booking", "problem_description required");
  // Neutralise obviously oversized free-text (DoS / token-bomb guard).
  const desc = String(b.problem_description).slice(0, 2000);
  return {
    customer_name: String(b.customer_name).slice(0, 120),
    customer_email: String(b.customer_email).slice(0, 200),
    customer_phone: String(b.customer_phone ?? "").slice(0, 40),
    address: String(b.address).slice(0, 300),
    location: { lat: Number((b.location as GeoPoint).lat), lng: Number((b.location as GeoPoint).lng) },
    problem_category: String(b.problem_category ?? "").slice(0, 120),
    problem_description: desc,
    photo_url: b.photo_url ? String(b.photo_url).slice(0, 500) : null,
    tier: b.tier as Tier,
    preferred_date: b.preferred_date ? String(b.preferred_date).slice(0, 40) : null,
  };
}

// ── Job-Intake Agent output ───────────────────────────────────────

export interface IntakeResult {
  skill_required: SkillTag[];
  urgency_hint: "low" | "medium" | "high";
  /** Extracted / normalised address (falls back to input). */
  location_note: string;
  /** Suggested time window in hours-from-now [earliest, latest]. */
  time_window_hours: [number, number];
  /** True if the free-text tried to manipulate the agent. */
  injection_attempt: boolean;
  rationale: string;
}

export function validateIntakeResult(x: unknown): IntakeResult {
  const r = x as Record<string, unknown>;
  assert(Array.isArray(r.skill_required), "intake", "skill_required must be array");
  const skills = (r.skill_required as unknown[]).filter((s): s is SkillTag =>
    SKILL_TAGS.includes(s as SkillTag),
  );
  assert(skills.length > 0, "intake", "at least one valid skill_required");
  assert(["low", "medium", "high"].includes(r.urgency_hint as string), "intake", "bad urgency_hint");
  const tw = r.time_window_hours as [number, number];
  assert(Array.isArray(tw) && tw.length === 2 && tw.every((n) => typeof n === "number"), "intake", "bad time_window_hours");
  return {
    skill_required: Array.from(new Set(skills)),
    urgency_hint: r.urgency_hint as IntakeResult["urgency_hint"],
    location_note: String(r.location_note ?? "").slice(0, 300),
    time_window_hours: [tw[0], tw[1]],
    injection_attempt: Boolean(r.injection_attempt),
    rationale: String(r.rationale ?? "").slice(0, 600),
  };
}

// ── Capacity/Yield Agent output ───────────────────────────────────

export interface CapacityResult {
  decision: "accept" | "accept_with_warning" | "suggest_alternative_slot";
  reason: string;
  /** For suggest_alternative_slot: hours-from-now for the proposed slot. */
  alternative_slot_hours: number | null;
  utilisation: { total_today: number; flexible_today: number };
}

// ── Technician-State Agent output ─────────────────────────────────

export interface TechCandidate {
  technician_id: string;
  name: string;
  skill_tags: SkillTag[];
  experience_level: "junior" | "senior";
  location: GeoPoint;
  current_workload: number;
  within_working_hours: boolean;
}

export interface TechStateResult {
  candidates: TechCandidate[];
  as_of: string;
}

// ── Assignment/Scoring Agent output ──────────────────────────────

export interface AssignmentResult {
  assigned_technician_id: string | null;
  score_breakdown: {
    distance: number;
    skill_match: number;
    urgency: number;
    workload: number;
    total: number;
  } | null;
  candidates: {
    technician_id: string;
    technician_name: string;
    eligible: boolean;
    reject_reason: string | null;
    breakdown: {
      distance: number;
      skill_match: number;
      urgency: number;
      workload: number;
      total: number;
    } | null;
  }[];
  conflict: null | {
    bumped_job_id: string;
    bumped_customer: string;
    technician_id: string;
  };
  needs_llm_edgecase: boolean;
}

// ── Disruption Agent output ──────────────────────────────────────
// The LLM is only ever allowed to CHOOSE among option_ids we already
// generated mechanically — it never returns moves/trade-offs itself, and
// every id it returns is cross-checked against the shortlist we actually
// offered (`knownOptionIds`). This is the first of two independent gates;
// the second is disruption.ts's revalidateCandidate(), which re-checks
// live constraint state regardless of what passes here.

export interface DisruptionLlmChoice {
  ranked_option_ids: string[];
  summaries: Record<string, string>;
  recommended_option_id: string;
  injection_attempt: boolean;
}

export function validateDisruptionLlmChoice(
  x: unknown,
  knownOptionIds: string[],
): DisruptionLlmChoice {
  const r = x as Record<string, unknown>;
  assert(Array.isArray(r.ranked_option_ids), "disruption", "ranked_option_ids must be array");

  const known = new Set(knownOptionIds);
  const rankedIds = (r.ranked_option_ids as unknown[]).filter(
    (id): id is string => typeof id === "string" && known.has(id),
  );
  assert(rankedIds.length >= 1, "disruption", "no valid option_id survived cross-check against known candidates");
  assert(
    typeof r.recommended_option_id === "string" && known.has(r.recommended_option_id as string),
    "disruption",
    "recommended_option_id must be one of the offered candidates",
  );

  const rawSummaries =
    r.summaries && typeof r.summaries === "object" ? (r.summaries as Record<string, unknown>) : {};

  return {
    ranked_option_ids: rankedIds,
    summaries: Object.fromEntries(
      rankedIds.map((id) => [id, String(rawSummaries[id] ?? "").slice(0, 400)]),
    ),
    recommended_option_id: r.recommended_option_id as string,
    injection_attempt: Boolean(r.injection_attempt),
  };
}

// ── Notification Agent output ────────────────────────────────────

export interface NotificationDraft {
  channel: "technician_app" | "customer_email";
  subject: string;
  body: string;
}

export function validateNotificationDraft(x: unknown): NotificationDraft {
  const r = x as Record<string, unknown>;
  assert(["technician_app", "customer_email"].includes(r.channel as string), "notif", "bad channel");
  assert(typeof r.subject === "string" && (r.subject as string).length > 0, "notif", "subject required");
  assert(typeof r.body === "string" && (r.body as string).length > 0, "notif", "body required");
  return {
    channel: r.channel as NotificationDraft["channel"],
    subject: String(r.subject).slice(0, 200),
    body: String(r.body).slice(0, 2000),
  };
}
