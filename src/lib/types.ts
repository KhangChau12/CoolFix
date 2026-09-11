// ── CoolFix domain model ────────────────────────────────────────────
// Source of truth for every agent-to-agent message and DB record.
// Kept deliberately close to CLAUDE.md §5; extended fields are marked.

export type SkillTag =
  | "basic_maintenance"
  | "refrigerant_handling"
  | "electrical_work"
  | "commercial_chiller";

export const SKILL_TAGS: SkillTag[] = [
  "basic_maintenance",
  "refrigerant_handling",
  "electrical_work",
  "commercial_chiller",
];

export const SKILL_LABEL: Record<SkillTag, string> = {
  basic_maintenance: "Basic maintenance",
  refrigerant_handling: "Refrigerant handling",
  electrical_work: "Electrical work",
  commercial_chiller: "Commercial chiller",
};

/** Real-world Singapore HVAC certification each skill maps to. */
export const SKILL_CERT: Record<SkillTag, string> = {
  basic_maintenance: "In-house servicing competency",
  refrigerant_handling: "NEA Certificate of Competency — Refrigerant Handling",
  electrical_work: "EMA Licensed Electrical Worker (LEW)",
  commercial_chiller: "BCA-registered chiller plant technician",
};

export type Tier = "urgent" | "priority" | "standard" | "flexible";

export const TIERS: Tier[] = ["urgent", "priority", "standard", "flexible"];

export interface TierMeta {
  tier: Tier;
  /** English label shown in the product UI. */
  label: string;
  /** Kept as an alias so older call sites compile. */
  labelEn: string;
  emoji: string;
  /** SLA window in hours from booking creation to scheduled service. */
  slaHours: number;
  /** Price multiplier applied to the base price for the job's skill. */
  priceMultiplier: number;
  /** Higher rank = higher priority; used by the Disruption Agent. */
  rank: number;
  /** May bump lower-tier not-yet-frozen jobs to claim their slot. */
  canBump: boolean;
  colorVar: string; // CSS custom property name
}

export const TIER_META: Record<Tier, TierMeta> = {
  urgent: {
    tier: "urgent",
    label: "Urgent",
    labelEn: "Urgent",
    emoji: "🔴",
    slaHours: 24,
    priceMultiplier: 1.75, // +75% (mid of +50–100%)
    rank: 4,
    canBump: true,
    colorVar: "--tier-urgent",
  },
  priority: {
    tier: "priority",
    label: "Priority",
    labelEn: "Priority",
    emoji: "🟠",
    slaHours: 72,
    priceMultiplier: 1.25, // +25% (mid of +20–30%)
    rank: 3,
    canBump: false,
    colorVar: "--tier-priority",
  },
  standard: {
    tier: "standard",
    label: "Standard",
    labelEn: "Standard",
    emoji: "🔵",
    slaHours: 168,
    priceMultiplier: 1.0,
    rank: 2,
    canBump: false,
    colorVar: "--tier-standard",
  },
  flexible: {
    tier: "flexible",
    label: "Flexible",
    labelEn: "Flexible",
    emoji: "🟢",
    slaHours: 336,
    priceMultiplier: 0.85, // -15% (mid of -10–20%)
    rank: 1,
    canBump: false,
    colorVar: "--tier-flexible",
  },
};

export const TIER_SLA_TEXT: Record<Tier, string> = {
  urgent: "within 24 hours",
  priority: "within 3 days",
  standard: "within 1 week",
  flexible: "within 2 weeks",
};

// ── Customer-facing problem categories ─────────────────────────────
// The dropdown on the booking form. Each maps to a suggested skill —
// a HINT for the Job-Intake Agent, which still re-derives from the
// free-text description (CLAUDE.md §6.1).

export interface ProblemCategory {
  value: string;
  label: string;
  hintSkill: SkillTag;
}

export const PROBLEM_CATEGORIES: ProblemCategory[] = [
  { value: "not_cooling", label: "Not cooling / water leak / strange noise", hintSkill: "refrigerant_handling" },
  { value: "routine", label: "Routine servicing / cleaning", hintSkill: "basic_maintenance" },
  { value: "install_electrical", label: "New installation / electrical fault", hintSkill: "electrical_work" },
  { value: "commercial", label: "Office / industrial system", hintSkill: "commercial_chiller" },
];

export const CATEGORY_HINT_SKILL: Record<string, SkillTag> = Object.fromEntries(
  PROBLEM_CATEGORIES.map((c) => [c.value, c.hintSkill]),
);

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface Technician {
  technician_id: string;
  name: string;
  photo_url: string;
  skill_tags: SkillTag[];
  experience_level: "junior" | "senior";
  location: GeoPoint;
  working_hours: { start: string; end: string }; // "HH:mm"
  /**
   * Head-count of jobs assigned today. Kept for the roster UI and as a
   * cheap fallback, but the Assignment Agent no longer scores off this
   * directly — it computes an hours-based utilisation from the live job
   * list instead (a 45-min clean and a 3-hour chiller job are not the same
   * "1"). See `ESTIMATED_DURATION_MIN` and `src/agents/scoring.ts`.
   */
  current_workload: number;
  phone: string; // extension: notification target
}

export type JobStatus =
  | "pending"
  | "assigned"
  | "frozen"
  | "in_progress"
  | "completed"
  | "disrupted";

/**
 * The Assignment Agent's score, component by component. Every component is
 * normalised to [0, 1] (1 = ideal for this job, 0 = worst in the candidate
 * pool) and the fields below are already multiplied by that tier's policy
 * weight, so they sum to `total` and `total` itself is in [0, 1] — a score
 * you can read as "how good a match is this technician for this job".
 *
 * This replaces the older additive `w1·(1/dist) + w2·skill + …` formula,
 * where the terms had different units and scales so skill and urgency were
 * effectively constant offsets that never separated one candidate from
 * another. See `src/agents/scoring.ts` and `DISPATCH_POLICY`.
 */
export interface ScoreBreakdown {
  /** Marginal detour this job adds to the technician's route today. */
  travel: number;
  /** Certification + right seniority for the job's complexity, minus a
   *  small penalty for sending an over-qualified technician to easy work. */
  skill_fit: number;
  /** Hours left in the technician's shift after taking this job. */
  availability: number;
  /** How close the job is to its SLA deadline (0 if this technician would
   *  make it miss the deadline). */
  sla_headroom: number;
  /** Pulls work toward technicians who are below the fleet's median load. */
  load_balance: number;
  /** Sum of the five weighted components, in [0, 1]. */
  total: number;
  /** Raw inputs behind the components, for the feed / tooltips. Not scored. */
  raw?: {
    detour_min: number;
    util_pct: number;
    hours_to_deadline: number | null;
  };
}

export interface Job {
  job_id: string;
  customer_name: string;
  customer_email: string; // extension: notification target
  customer_phone: string;
  location: GeoPoint & { address: string };
  problem_description: string; // free text from customer
  problem_category: string; // dropdown value (hint only)
  photo_url: string | null;
  skill_required: SkillTag[]; // Job-Intake Agent output
  tier: Tier;
  scheduled_time: string; // ISO datetime
  freeze_point: string; // = scheduled_time - freezeWindowHours
  status: JobStatus;
  assigned_technician_id: string | null;
  score_breakdown: ScoreBreakdown | null;
  price: number;
  created_at: string;
  /** Pipeline stage for the "Job Queue" board. */
  pipeline_stage: PipelineStage;
  /** Set when this job was moved by a disruption re-plan. */
  reschedule_history: RescheduleEntry[];
}

export type PipelineStage =
  | "intake"
  | "pricing"
  | "capacity_check"
  | "scoring"
  | "assigned"
  | "disruption_review"
  | "awaiting_approval"
  | "done";

/** Single source of truth for pipeline-stage order + labels (Queue page, Dashboard).
 * Order matches the orchestrator: intake first, then pricing on the real skills. */
export const PIPELINE_STAGES: { key: PipelineStage; label: string }[] = [
  { key: "intake", label: "Intake" },
  { key: "pricing", label: "Pricing" },
  { key: "capacity_check", label: "Capacity" },
  { key: "scoring", label: "Scoring" },
  { key: "assigned", label: "Assigned" },
  { key: "disruption_review", label: "Disruption" },
  { key: "awaiting_approval", label: "Awaiting approval" },
  { key: "done", label: "Done" },
];

export interface RescheduleEntry {
  at: string;
  from_time: string;
  to_time: string;
  reason: string;
  decided_by: string; // "auto" | coordinator name
}

// ── Agent decision log (Observability spine) ────────────────────────

export type AgentName =
  | "PricingEngine"
  | "JobIntakeAgent"
  | "CapacityAgent"
  | "TechnicianStateAgent"
  | "AssignmentAgent"
  | "AssignmentTiebreakAgent"
  | "AssignmentEdgecaseAgent"
  | "DisruptionAgent"
  | "NotificationAgent"
  | "Orchestrator";

export type DecisionOutcome =
  | "auto_commit"
  | "requires_approval"
  | "approved"
  | "rejected"
  | "info";

export interface AgentDecisionLog {
  log_id: string;
  timestamp: string;
  agent_name: AgentName;
  job_id: string;
  /** LLM | rule — surfaced in the feed so judges see cost discipline. */
  reasoning_kind: "llm" | "rule";
  input_summary: Record<string, unknown>;
  output_summary: Record<string, unknown>;
  /** Optional score breakdown for AssignmentAgent rows. */
  score_breakdown?: ScoreBreakdown | null;
  /** Optional candidate ranking for AssignmentAgent rows. */
  candidates?: CandidateScore[] | null;
  /** Optional re-plan options for DisruptionAgent rows. */
  replan_options?: ReplanOption[] | null;
  requires_human_approval: boolean;
  outcome: DecisionOutcome;
  approved_by: string | null; // null if auto-commit
  /** Human-readable one-liner for the feed. */
  headline: string;
  /** ms spent (stub: simulated). */
  latency_ms: number;
  /** Guardrail notes: injection flags, least-privilege denials, etc. */
  guardrail_notes: string[];
}

export interface CandidateScore {
  technician_id: string;
  technician_name: string;
  eligible: boolean;
  reject_reason: string | null; // skill hard-constraint failure, off-hours, etc.
  breakdown: ScoreBreakdown | null;
}

// ── Disruption / HITL ──────────────────────────────────────────────

export interface ReplanOption {
  option_id: string;
  label: string;
  summary: string;
  /** For LLM-designed plans: the model's own one-sentence justification for
   * THIS plan (distinct from `summary`, which describes the trade-off
   * numbers). Absent on mechanical fallback options. */
  plan_rationale?: string;
  moves: {
    job_id: string;
    customer_name: string;
    from_time: string;
    to_time: string;
    technician_id: string;
  }[];
  trade_offs: {
    customers_affected: number;
    total_added_travel_km: number;
    sla_breaches: number;
    frozen_jobs_touched: number;
    /** Total hours every moved job is pushed away from its original slot
     * (sum of |from − to| across moves). Lower is less disruptive. */
    total_shift_hours?: number;
    /** Smallest gap, in hours, between any moved job's new slot and the
     * nearest OTHER job on the same technician. A small value means the job
     * was squeezed in tight; a comfortable re-plan keeps this large. */
    tightest_gap_hours?: number;
  };
  recommended: boolean;
}

export type ApprovalKind = "standard" | "emergency_override";

export interface ApprovalRequest {
  approval_id: string;
  created_at: string;
  kind: ApprovalKind;
  job_id: string; // the incoming job that triggered the re-plan
  reason: string;
  disruption_log_id: string;
  options: ReplanOption[];
  chosen_option_id: string | null;
  status: "pending" | "approved" | "rejected";
  resolved_by: string | null;
  resolved_at: string | null;
  /** For emergency override: which frozen jobs are impacted. */
  frozen_jobs_impacted: string[];
}

// ── Notifications (two-way, for the demo) ──────────────────────────

export type NotificationChannel = "technician_app" | "customer_email";

export interface NotificationRecord {
  notification_id: string;
  created_at: string;
  channel: NotificationChannel;
  recipient_id: string; // technician_id or customer_email
  job_id: string;
  kind:
    | "new_assignment"
    | "reschedule"
    | "reminder_t3h"
    | "booking_confirmed"
    | "completed";
  subject: string;
  body: string;
  acknowledged: boolean;
  acknowledged_at: string | null;
}

// ── Runtime config (Settings screen) ──────────────────────────────

export interface RuntimeConfig {
  freezeWindowHours: number;
  /**
   * How the Assignment Agent weighs the five scoring components, per tier.
   * Each tier's five weights should sum to 1 (the config API normalises them
   * if they don't). This is where a coordinator expresses dispatch policy:
   * "urgent = speed + the right person", "flexible = spread the work and
   * keep costs even". Replaces the old flat `scoreWeights` — see
   * `DISPATCH_POLICY` for the shipped defaults and `src/agents/scoring.ts`.
   */
  dispatchPolicy: Record<Tier, Record<ScoreComponent, number>>;
  /** Disruption auto-commit threshold: max customers affected. */
  hitlMaxCustomersAffected: number;
  /** Disruption auto-commit threshold: max added travel km. */
  hitlMaxAddedTravelKm: number;
  /** Capacity cap: max flexible-tier jobs accepted per day. */
  capacityFlexiblePerDay: number;
  /** Capacity cap: max total jobs per day across the fleet. */
  capacityTotalPerDay: number;
  /** Base price (SGD) per required skill. */
  basePrice: Record<SkillTag, number>;
  llmMode: "stub" | "gateway" | "openai";
}

// ── Assignment scoring ────────────────────────────────────────────
// The five components the Assignment Agent scores a technician on. Each is
// a pure function returning [0, 1] (see src/agents/scoring.ts); the tier's
// DISPATCH_POLICY weights decide how much each one counts.

export type ScoreComponent =
  | "travel"
  | "skillFit"
  | "availability"
  | "slaHeadroom"
  | "loadBalance";

export const SCORE_COMPONENTS: ScoreComponent[] = [
  "travel",
  "skillFit",
  "availability",
  "slaHeadroom",
  "loadBalance",
];

export const SCORE_COMPONENT_LABEL: Record<ScoreComponent, string> = {
  travel: "Travel fit",
  skillFit: "Skill fit",
  availability: "Availability",
  slaHeadroom: "SLA headroom",
  loadBalance: "Load balance",
};

/**
 * Default dispatch policy per tier. Each row sums to 1.0. Read it as the
 * business rule it is:
 *   • urgent   — get there fast, with the right person; deadline pressure
 *                matters; don't spend effort balancing the day.
 *   • priority — still lean on speed and skill, but start balancing load.
 *   • standard — travel still counts, but an even, sustainable day matters
 *                as much.
 *   • flexible — the customer has weeks of slack; spread the work to
 *                whoever is under-loaded and keep routes tight.
 */
export const DISPATCH_POLICY: Record<Tier, Record<ScoreComponent, number>> = {
  urgent: { travel: 0.42, skillFit: 0.28, availability: 0.12, slaHeadroom: 0.18, loadBalance: 0.0 },
  priority: { travel: 0.34, skillFit: 0.26, availability: 0.15, slaHeadroom: 0.12, loadBalance: 0.13 },
  standard: { travel: 0.28, skillFit: 0.22, availability: 0.17, slaHeadroom: 0.05, loadBalance: 0.28 },
  flexible: { travel: 0.22, skillFit: 0.18, availability: 0.18, slaHeadroom: 0.02, loadBalance: 0.4 },
};

/**
 * Estimated on-site duration per skill (minutes). Used by the scoring pass
 * (availability / load-balance from real hours, not a job head-count) and
 * by the route-feasibility hard constraint (can the technician get from
 * their previous job to this one before it starts?). A job needing several
 * skills takes the longest of them, plus a small buffer per extra skill.
 */
export const ESTIMATED_DURATION_MIN: Record<SkillTag, number> = {
  basic_maintenance: 60,
  refrigerant_handling: 90,
  electrical_work: 120,
  commercial_chiller: 180,
};

/** Minutes added per required skill beyond the first (a multi-skill visit
 *  runs longer than the single longest task). */
export const MULTI_SKILL_BUFFER_MIN = 30;

/** Estimated on-site minutes for a job needing `skills`. */
export function estimatedJobMinutes(skills: SkillTag[]): number {
  if (skills.length === 0) return ESTIMATED_DURATION_MIN.basic_maintenance;
  const longest = Math.max(...skills.map((s) => ESTIMATED_DURATION_MIN[s]));
  return longest + Math.max(0, skills.length - 1) * MULTI_SKILL_BUFFER_MIN;
}

/**
 * Is a job "complex" — one where sending a senior technician genuinely
 * matters (chiller plant, a multi-skill visit, or a high-urgency call where
 * a wrong diagnosis is expensive)? Drives the `skillFit` seniority term.
 */
export function jobIsComplex(
  skills: SkillTag[],
  urgencyHint: "low" | "medium" | "high",
): boolean {
  return (
    skills.includes("commercial_chiller") ||
    skills.length >= 2 ||
    urgencyHint === "high"
  );
}

/**
 * A re-plan may auto-commit only when EVERY one of these holds (checked in
 * disruption.ts `replanQualifiesForAutoCommit`). The config thresholds
 * (`hitlMaxCustomersAffected`, `hitlMaxAddedTravelKm`) are the tunable part;
 * these are the fixed safety rails that make "1 customer affected" safe
 * enough to skip the human — a genuinely low-impact move only.
 */
export const AUTO_REPLAN_LIMITS = {
  /** Only ever auto-move a Flexible-tier job. A Standard/Priority/Urgent
   * customer's appointment moving always goes to a coordinator, even when
   * the move itself looks small. */
  movableTiers: ["flexible"] as Tier[],
  /** Max total hours any job is shifted from its original slot. */
  maxShiftHours: 3,
  /** Every moved job must keep at least this gap (h) to its neighbour. */
  minGapHours: 2,
  /** Never auto-move a job that was already rescheduled once. */
  maxPriorReschedules: 0,
};

export const DEFAULT_CONFIG: RuntimeConfig = {
  freezeWindowHours: 2,
  dispatchPolicy: DISPATCH_POLICY,
  // 1 = a re-plan that moves ONE customer's appointment may auto-commit —
  // but only if it also clears every rail in AUTO_REPLAN_LIMITS (Flexible
  // tier only, same-day, <=3h shift, >=2h gap, no SLA breach, not already
  // rescheduled). Anything above 1 customer, a Standard/Priority job, or any
  // rail broken, still goes to the Approvals queue. Set this to 0 to review
  // every customer-visible move.
  hitlMaxCustomersAffected: 1,
  hitlMaxAddedTravelKm: 8,
  capacityFlexiblePerDay: 6,
  capacityTotalPerDay: 24,
  basePrice: {
    basic_maintenance: 80,
    refrigerant_handling: 160,
    electrical_work: 180,
    commercial_chiller: 320,
  },
  llmMode: "stub",
};
