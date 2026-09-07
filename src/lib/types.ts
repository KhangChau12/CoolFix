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
  current_workload: number; // jobs assigned today; feeds scoring
  phone: string; // extension: notification target
}

export type JobStatus =
  | "pending"
  | "assigned"
  | "frozen"
  | "in_progress"
  | "completed"
  | "disrupted";

export interface ScoreBreakdown {
  distance: number;
  skill_match: number;
  urgency: number;
  workload: number;
  total: number;
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
  scoreWeights: { w1: number; w2: number; w3: number; w4: number };
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
  llmMode: "stub" | "bedrock" | "openai";
}

export const DEFAULT_CONFIG: RuntimeConfig = {
  freezeWindowHours: 2,
  scoreWeights: { w1: 1.0, w2: 2.0, w3: 1.5, w4: 1.0 },
  // 0 = every re-plan that moves a customer's appointment goes to the
  // coordinator. CoolFix positions on reliability, so any customer-visible
  // disruption gets a human check. Raise this to let low-impact moves
  // auto-commit (Settings screen).
  hitlMaxCustomersAffected: 0,
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
