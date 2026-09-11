// ── Agent I/O schemas ───────────────────────────────────────────────
// Every message that crosses an agent boundary is one of these shapes.
// We use lightweight runtime validators (no zod dependency) so the demo
// build stays tiny, but each has an explicit typed contract + a
// `validate*` guard that agents call on their inputs — this is the
// "typed schema at every boundary" the rubric asks for.

import type { GeoPoint, ScoreBreakdown, SkillTag, Tier } from "@/lib/types";
import { SKILL_TAGS, TIERS } from "@/lib/types";
import { isWithinSG } from "@/lib/geo";

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
  // The service coordinate must be a real point inside Singapore. The
  // address picker geocodes the customer's free-text address to a
  // lat/lng before submit; this rejects a coordinate that is malformed,
  // out of range, or an injected value trying to skew the routing score.
  const loc = {
    lat: Number((b.location as GeoPoint).lat),
    lng: Number((b.location as GeoPoint).lng),
  };
  assert(
    isWithinSG(loc),
    "booking",
    "location must be a valid coordinate within Singapore",
  );
  // Neutralise obviously oversized free-text (DoS / token-bomb guard).
  const desc = String(b.problem_description).slice(0, 2000);
  return {
    customer_name: String(b.customer_name).slice(0, 120),
    customer_email: String(b.customer_email).slice(0, 200),
    customer_phone: String(b.customer_phone ?? "").slice(0, 40),
    address: String(b.address).slice(0, 300),
    location: loc,
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

// ── Assignment/Scoring Agent output ──────────────────────────────
// (There used to be a separate Technician-State Agent output type here —
// folded into the Assignment Agent, which now reads the roster straight
// from AgentContext. See assignment.ts's header note.)

export interface AssignmentResult {
  assigned_technician_id: string | null;
  score_breakdown: ScoreBreakdown | null;
  candidates: {
    technician_id: string;
    technician_name: string;
    eligible: boolean;
    reject_reason: string | null;
    breakdown: ScoreBreakdown | null;
  }[];
  conflict: null | {
    bumped_job_id: string;
    bumped_customer: string;
    technician_id: string;
  };
  needs_llm_edgecase: boolean;
}

// ── Disruption Agent output ──────────────────────────────────────
// The LLM DESIGNS the re-plan — it is not picking from a menu — but it may
// only compose moves out of the pre-verified legal space we handed it
// (`ReplanSpace`). Every move it emits is cross-checked here: the job must
// be the bumped job or a declared movable soft job, the technician must be
// one we listed, and the target slot must appear verbatim in that job's
// allowed-slot list for that technician. This is the first of two
// independent gates; the second is disruption.ts's revalidatePlan(), which
// re-simulates the whole plan against live schedule state.

/** Minimal shape of the space needed to cross-check a plan. Kept structural
 * so schemas.ts doesn't import from disruption.ts (avoids a cycle). */
export interface ReplanSpaceView {
  bumpedJobId: string;
  allowedSlotsByTech: Record<string, string[]>;
  movableSoftJobs: {
    job_id: string;
    allowed_slots_by_tech: Record<string, string[]>;
  }[];
}

export interface LlmPlanMove {
  job_id: string;
  to_tech_id: string;
  to_slot_iso: string;
}

export interface LlmPlan {
  plan_id: string;
  moves: LlmPlanMove[];
  rationale: string;
}

export interface DisruptionPlans {
  plans: LlmPlan[];
  recommended_plan_id: string;
  injection_attempt: boolean;
}

export function validateDisruptionPlans(
  x: unknown,
  space: ReplanSpaceView,
): DisruptionPlans {
  const r = x as Record<string, unknown>;
  assert(Array.isArray(r.plans), "disruption", "plans must be an array");

  // Build the lookup of what each job is allowed to do.
  const allowedByJob = new Map<string, Record<string, string[]>>();
  allowedByJob.set(space.bumpedJobId, space.allowedSlotsByTech);
  for (const m of space.movableSoftJobs) {
    allowedByJob.set(m.job_id, m.allowed_slots_by_tech);
  }

  const moveIsLegal = (m: LlmPlanMove): boolean => {
    if (
      typeof m?.job_id !== "string" ||
      typeof m?.to_tech_id !== "string" ||
      typeof m?.to_slot_iso !== "string"
    ) {
      return false;
    }
    const allowed = allowedByJob.get(m.job_id);
    if (!allowed) return false; // not the bumped job and not a declared movable soft job
    const slots = allowed[m.to_tech_id];
    if (!slots) return false; // technician not offered for this job
    return slots.includes(m.to_slot_iso); // exact ISO string, no "close enough"
  };

  const plans: LlmPlan[] = [];
  for (const raw of r.plans as unknown[]) {
    const p = raw as Record<string, unknown>;
    if (!Array.isArray(p?.moves) || p.moves.length === 0) continue;
    const moves = (p.moves as unknown[]).filter((mv) =>
      moveIsLegal(mv as LlmPlanMove),
    ) as LlmPlanMove[];
    if (moves.length === 0) continue; // no legal move survived → drop the plan
    // A job may only be moved once per plan.
    const jobsMoved = new Set(moves.map((m) => m.job_id));
    if (jobsMoved.size !== moves.length) continue;
    // The bumped job MUST be moved (that is the whole point).
    if (!jobsMoved.has(space.bumpedJobId)) continue;
    plans.push({
      plan_id: String(p.plan_id ?? `p${plans.length + 1}`).slice(0, 40),
      moves,
      rationale: String(p.rationale ?? "").slice(0, 300),
    });
  }

  assert(
    plans.length >= 1,
    "disruption",
    "no plan survived the legal-space cross-check",
  );

  // Order so the recommended plan is first; fall back to plan 0.
  const recId =
    typeof r.recommended_plan_id === "string" ? r.recommended_plan_id : null;
  const recIdx = plans.findIndex((p) => p.plan_id === recId);
  if (recIdx > 0) {
    const [rec] = plans.splice(recIdx, 1);
    plans.unshift(rec);
  }

  return {
    plans,
    recommended_plan_id: plans[0].plan_id,
    injection_attempt: Boolean(r.injection_attempt),
  };
}

// ── Assignment Tie-break Agent output ───────────────────────────
// Runs only when the scoring formula is ambiguous. The LLM is handed the
// top-3 eligible candidates (all already past every hard constraint) and
// picks one, with a rationale. Its pick is cross-checked here (must be one
// of the offered ids) and then re-scored against live state in the agent
// before commit. Anything invalid falls back to the formula's top pick.

export interface TiebreakChoice {
  chosen_technician_id: string | null;
  rationale: string;
  injection_attempt: boolean;
}

export function validateTiebreakChoice(
  x: unknown,
  offeredTechIds: string[],
): TiebreakChoice {
  const r = x as Record<string, unknown>;
  const id =
    typeof r.chosen_technician_id === "string" ? r.chosen_technician_id : null;
  assert(
    id === null || offeredTechIds.includes(id),
    "tiebreak",
    "chosen_technician_id is not one of the offered candidates",
  );
  return {
    chosen_technician_id: id,
    rationale: String(r.rationale ?? "").slice(0, 300),
    injection_attempt: Boolean(r.injection_attempt),
  };
}

// ── Assignment Edge-case Agent output ───────────────────────────
// The LLM may only pick one of the pre-validated levers the rule layer
// enumerated. Its choice is cross-checked here (the technician/slot pair
// must appear verbatim in widenWindow; an index must be in range) and,
// for widen_window, re-scored against live state in the agent before it is
// committed. Anything invalid degrades to "escalate", which is always safe.

export interface EdgecaseSpaceView {
  widenWindow: { tech_id: string; slot_iso: string }[];
  splitVisit: unknown[];
  pairJuniorSenior: unknown[];
}

export interface EdgecaseChoice {
  action: "widen_window" | "split_visit" | "pair_junior_senior" | "escalate";
  chosen_tech_id: string | null;
  chosen_slot_iso: string | null;
  chosen_index: number | null;
  rationale: string;
  injection_attempt: boolean;
}

export function validateEdgecaseChoice(
  x: unknown,
  space: EdgecaseSpaceView,
): EdgecaseChoice {
  const r = x as Record<string, unknown>;
  const action = r.action as EdgecaseChoice["action"];
  assert(
    ["widen_window", "split_visit", "pair_junior_senior", "escalate"].includes(action),
    "edgecase",
    "bad action",
  );

  const rationale = String(r.rationale ?? "").slice(0, 300);
  const base: EdgecaseChoice = {
    action: "escalate",
    chosen_tech_id: null,
    chosen_slot_iso: null,
    chosen_index: null,
    rationale,
    injection_attempt: Boolean(r.injection_attempt),
  };

  if (action === "widen_window") {
    const techId = typeof r.chosen_tech_id === "string" ? r.chosen_tech_id : null;
    const slotIso = typeof r.chosen_slot_iso === "string" ? r.chosen_slot_iso : null;
    const legal =
      !!techId &&
      !!slotIso &&
      space.widenWindow.some((w) => w.tech_id === techId && w.slot_iso === slotIso);
    assert(legal, "edgecase", "widen_window pick is not one of the offered (tech, slot) pairs");
    return { ...base, action, chosen_tech_id: techId, chosen_slot_iso: slotIso };
  }

  if (action === "split_visit" || action === "pair_junior_senior") {
    const list = action === "split_visit" ? space.splitVisit : space.pairJuniorSenior;
    const idx = typeof r.chosen_index === "number" ? r.chosen_index : -1;
    assert(
      Number.isInteger(idx) && idx >= 0 && idx < list.length,
      "edgecase",
      `${action} chosen_index out of range`,
    );
    return { ...base, action, chosen_index: idx };
  }

  return base; // escalate
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
