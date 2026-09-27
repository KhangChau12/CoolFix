// ── Row ↔ domain mappers ────────────────────────────────────────────
// snake_case Postgres rows <-> our TS domain objects. Isolated here so
// the repo and agents never touch raw row shapes.

import type {
  AgentDecisionLog,
  AdaptivePolicyChangeHistory,
  AdaptivePolicyRecommendation,
  ApprovalRequest,
  Job,
  JobFeedback,
  NotificationRecord,
  RuntimeConfig,
  Technician,
} from "./types";
import { DISPATCH_POLICY, FEEDBACK_IMPROVEMENT_TAGS, FEEDBACK_POSITIVE_TAGS } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */

export function rowToTechnician(r: any): Technician {
  return {
    technician_id: r.technician_id,
    name: r.name,
    photo_url: r.photo_url ?? "",
    skill_tags: r.skill_tags ?? [],
    experience_level: r.experience_level,
    location: r.location,
    working_hours: r.working_hours,
    current_workload: r.current_workload ?? 0,
    phone: r.phone ?? "",
  };
}

export function technicianToRow(t: Technician) {
  return {
    technician_id: t.technician_id,
    name: t.name,
    photo_url: t.photo_url,
    skill_tags: t.skill_tags,
    experience_level: t.experience_level,
    location: t.location,
    working_hours: t.working_hours,
    current_workload: t.current_workload,
    phone: t.phone,
  };
}

export function rowToJob(r: any): Job {
  return {
    job_id: r.job_id,
    customer_name: r.customer_name,
    customer_email: r.customer_email,
    customer_phone: r.customer_phone ?? "",
    location: r.location,
    problem_description: r.problem_description,
    problem_category: r.problem_category ?? "",
    photo_url: r.photo_url ?? null,
    skill_required: r.skill_required ?? [],
    tier: r.tier,
    scheduled_time: toISO(r.scheduled_time),
    freeze_point: toISO(r.freeze_point),
    status: r.status,
    assigned_technician_id: r.assigned_technician_id ?? null,
    score_breakdown: r.score_breakdown ?? null,
    price: Number(r.price ?? 0),
    created_at: toISO(r.created_at),
    pipeline_stage: r.pipeline_stage ?? "intake",
    reschedule_history: r.reschedule_history ?? [],
    public_tracking_token: r.public_tracking_token,
    tech_substatus: r.tech_substatus ?? null,
    dispatch_policy_version: r.dispatch_policy_version ?? null,
    dispatch_policy_snapshot: r.dispatch_policy_snapshot ?? null,
  };
}

export function jobToRow(j: Job) {
  return {
    job_id: j.job_id,
    customer_name: j.customer_name,
    customer_email: j.customer_email,
    customer_phone: j.customer_phone,
    location: j.location,
    problem_description: j.problem_description,
    problem_category: j.problem_category,
    photo_url: j.photo_url,
    skill_required: j.skill_required,
    tier: j.tier,
    scheduled_time: j.scheduled_time,
    freeze_point: j.freeze_point,
    status: j.status,
    assigned_technician_id: j.assigned_technician_id,
    score_breakdown: j.score_breakdown,
    price: j.price,
    created_at: j.created_at,
    pipeline_stage: j.pipeline_stage,
    reschedule_history: j.reschedule_history,
    public_tracking_token: j.public_tracking_token,
    tech_substatus: j.tech_substatus,
    dispatch_policy_version: j.dispatch_policy_version ?? null,
    dispatch_policy_snapshot: j.dispatch_policy_snapshot ?? null,
  };
}

export function rowToDecision(r: any): AgentDecisionLog {
  return {
    log_id: r.log_id,
    timestamp: toISO(r.timestamp),
    agent_name: r.agent_name,
    job_id: r.job_id,
    reasoning_kind: r.reasoning_kind,
    input_summary: r.input_summary ?? {},
    output_summary: r.output_summary ?? {},
    score_breakdown: r.score_breakdown ?? null,
    candidates: r.candidates ?? null,
    replan_options: r.replan_options ?? null,
    requires_human_approval: r.requires_human_approval ?? false,
    outcome: r.outcome,
    approved_by: r.approved_by ?? null,
    headline: r.headline,
    latency_ms: r.latency_ms ?? 0,
    guardrail_notes: r.guardrail_notes ?? [],
    policy_version: r.policy_version ?? null,
    dispatch_policy_snapshot: r.dispatch_policy_snapshot ?? null,
  };
}

export function decisionToRow(d: AgentDecisionLog) {
  return {
    log_id: d.log_id,
    timestamp: d.timestamp,
    agent_name: d.agent_name,
    job_id: d.job_id,
    reasoning_kind: d.reasoning_kind,
    input_summary: d.input_summary,
    output_summary: d.output_summary,
    score_breakdown: d.score_breakdown ?? null,
    candidates: d.candidates ?? null,
    replan_options: d.replan_options ?? null,
    requires_human_approval: d.requires_human_approval,
    outcome: d.outcome,
    approved_by: d.approved_by,
    headline: d.headline,
    latency_ms: d.latency_ms,
    guardrail_notes: d.guardrail_notes,
    policy_version: d.policy_version ?? null,
    dispatch_policy_snapshot: d.dispatch_policy_snapshot ?? null,
  };
}

export function rowToApproval(r: any): ApprovalRequest {
  return {
    approval_id: r.approval_id,
    created_at: toISO(r.created_at),
    kind: r.kind,
    job_id: r.job_id,
    reason: r.reason,
    disruption_log_id: r.disruption_log_id,
    options: r.options ?? [],
    chosen_option_id: r.chosen_option_id ?? null,
    status: r.status,
    resolved_by: r.resolved_by ?? null,
    resolved_at: r.resolved_at ? toISO(r.resolved_at) : null,
    frozen_jobs_impacted: r.frozen_jobs_impacted ?? [],
  };
}

export function approvalToRow(a: ApprovalRequest) {
  return {
    approval_id: a.approval_id,
    created_at: a.created_at,
    kind: a.kind,
    job_id: a.job_id,
    reason: a.reason,
    disruption_log_id: a.disruption_log_id,
    options: a.options,
    chosen_option_id: a.chosen_option_id,
    status: a.status,
    resolved_by: a.resolved_by,
    resolved_at: a.resolved_at,
    frozen_jobs_impacted: a.frozen_jobs_impacted,
  };
}

export function rowToNotification(r: any): NotificationRecord {
  return {
    notification_id: r.notification_id,
    created_at: toISO(r.created_at),
    channel: r.channel,
    recipient_id: r.recipient_id,
    job_id: r.job_id,
    kind: r.kind,
    subject: r.subject,
    body: r.body,
    acknowledged: r.acknowledged ?? false,
    acknowledged_at: r.acknowledged_at ? toISO(r.acknowledged_at) : null,
  };
}

export function notificationToRow(n: NotificationRecord) {
  return {
    notification_id: n.notification_id,
    created_at: n.created_at,
    channel: n.channel,
    recipient_id: n.recipient_id,
    job_id: n.job_id,
    kind: n.kind,
    subject: n.subject,
    body: n.body,
    acknowledged: n.acknowledged,
    acknowledged_at: n.acknowledged_at,
  };
}

export function rowToConfig(r: any): RuntimeConfig {
  return {
    freezeWindowHours: Number(r.freeze_window_hours ?? 3),
    // Keep the legacy API fields for older clients, but ignore saved clocks.
    clockMode: "real",
    customTimeISO: null,
    // dispatch_policy is the new per-tier scoring policy. Older rows (or a
    // pre-migration DB) won't have the column — fall back to the shipped
    // default so the pipeline always has a full policy.
    dispatchPolicy: isFullPolicy(r.dispatch_policy)
      ? withoutClockMetadata(r.dispatch_policy)
      : DISPATCH_POLICY,
    hitlMaxCustomersAffected: r.hitl_max_customers_affected ?? 1,
    hitlMaxAddedTravelKm: Number(r.hitl_max_added_travel_km ?? 8),
    capacityFlexiblePerDay: r.capacity_flexible_per_day ?? 6,
    capacityTotalPerDay: r.capacity_total_per_day ?? 24,
    basePrice: r.base_price ?? {
      basic_maintenance: 80,
      refrigerant_handling: 160,
      electrical_work: 180,
      commercial_chiller: 320,
    },
    llmMode: r.llm_mode ?? "stub",
    policyVersion: r.policy_version ?? "policy-v1",
    adaptivePolicy: {
      enabled: r.adaptive_policy_enabled ?? false,
      mode: r.adaptive_policy_mode === "automatic" ? "automatic" : "recommendation_only",
      minFeedbackCount: Number(r.adaptive_min_feedback_count ?? 20),
      minUniqueTechnicians: Number(r.adaptive_min_unique_technicians ?? 3),
      maxChangePerUpdate: Number(r.adaptive_max_change ?? 0.02),
      cooldownDays: Number(r.adaptive_cooldown_days ?? 14),
      minConfidence: Number(r.adaptive_min_confidence ?? 0.75),
      maxCustomerSatisfactionWeight: Number(r.adaptive_max_customer_satisfaction_weight ?? 0.15),
    },
  };
}

export function configToRow(
  c: Partial<RuntimeConfig>,
  options: { embedClockFallback?: boolean } = {},
) {
  const row: Record<string, unknown> = { id: 1, updated_at: new Date().toISOString() };
  if (c.freezeWindowHours !== undefined) row.freeze_window_hours = c.freezeWindowHours;
  row.clock_mode = "real";
  row.custom_time_iso = null;
  if (c.dispatchPolicy !== undefined) {
    row.dispatch_policy = options.embedClockFallback &&
      (c.clockMode !== undefined || c.customTimeISO !== undefined)
      ? {
          ...c.dispatchPolicy,
          _coolfix_clock: {
            clockMode: "real",
            customTimeISO: null,
          },
        }
      : c.dispatchPolicy;
  }
  if (c.hitlMaxCustomersAffected !== undefined)
    row.hitl_max_customers_affected = c.hitlMaxCustomersAffected;
  if (c.hitlMaxAddedTravelKm !== undefined)
    row.hitl_max_added_travel_km = c.hitlMaxAddedTravelKm;
  if (c.capacityFlexiblePerDay !== undefined)
    row.capacity_flexible_per_day = c.capacityFlexiblePerDay;
  if (c.capacityTotalPerDay !== undefined)
    row.capacity_total_per_day = c.capacityTotalPerDay;
  if (c.basePrice !== undefined) row.base_price = c.basePrice;
  if (c.llmMode !== undefined) row.llm_mode = c.llmMode;
  if (c.policyVersion !== undefined) row.policy_version = c.policyVersion;
  if (c.adaptivePolicy !== undefined) {
    row.adaptive_policy_enabled = c.adaptivePolicy.enabled;
    row.adaptive_policy_mode = c.adaptivePolicy.mode;
    row.adaptive_min_feedback_count = c.adaptivePolicy.minFeedbackCount;
    row.adaptive_min_unique_technicians = c.adaptivePolicy.minUniqueTechnicians;
    row.adaptive_max_change = c.adaptivePolicy.maxChangePerUpdate;
    row.adaptive_cooldown_days = c.adaptivePolicy.cooldownDays;
    row.adaptive_min_confidence = c.adaptivePolicy.minConfidence;
    row.adaptive_max_customer_satisfaction_weight = c.adaptivePolicy.maxCustomerSatisfactionWeight;
  }
  return row;
}

function toISO(v: unknown): string {
  if (!v) return new Date().toISOString();
  if (v instanceof Date) return v.toISOString();
  return new Date(String(v)).toISOString();
}

/** A stored dispatch_policy is usable only if it has all four tiers, each
 *  with all six component weights as numbers. Anything partial → use the
 *  shipped default rather than scoring off a half-filled policy. */
function isFullPolicy(p: unknown): p is RuntimeConfig["dispatchPolicy"] {
  if (!p || typeof p !== "object") return false;
  const tiers = ["urgent", "priority", "standard", "flexible"] as const;
  const keys = [
    "travel",
    "skillFit",
    "availability",
    "slaHeadroom",
    "loadBalance",
    "customerSatisfaction",
  ] as const;
  return tiers.every((tier) => {
    const row = (p as Record<string, unknown>)[tier];
    if (!row || typeof row !== "object") return false;
    return keys.every((k) => typeof (row as Record<string, unknown>)[k] === "number");
  });
}

function withoutClockMetadata(
  p: RuntimeConfig["dispatchPolicy"],
): RuntimeConfig["dispatchPolicy"] {
  const copy = { ...(p as Record<string, unknown>) };
  delete copy._coolfix_clock;
  return copy as RuntimeConfig["dispatchPolicy"];
}

// ── Job feedback ────────────────────────────────────────────────────

export function rowToFeedback(r: any): JobFeedback {
  return {
    feedback_id: r.feedback_id,
    job_id: r.job_id,
    technician_id: r.technician_id,
    rating: Number(r.rating),
    positive_tags: sanitizeTagArray(r.positive_tags, FEEDBACK_POSITIVE_TAGS),
    improvement_tags: sanitizeTagArray(r.improvement_tags, FEEDBACK_IMPROVEMENT_TAGS),
    comment: r.comment ?? null,
    created_at: toISO(r.created_at),
    source_hash: r.source_hash ?? null,
    flagged: r.flagged ?? false,
    excluded_from_adaptation: r.excluded_from_adaptation ?? false,
    flag_reason: r.flag_reason ?? null,
  };
}

export function feedbackToRow(f: JobFeedback) {
  return {
    feedback_id: f.feedback_id,
    job_id: f.job_id,
    technician_id: f.technician_id,
    rating: f.rating,
    positive_tags: f.positive_tags,
    improvement_tags: f.improvement_tags,
    comment: f.comment,
    created_at: f.created_at,
    source_hash: f.source_hash ?? null,
    flagged: f.flagged ?? false,
    excluded_from_adaptation: f.excluded_from_adaptation ?? false,
    flag_reason: f.flag_reason ?? null,
  };
}

export function rowToAdaptiveRecommendation(r: any): AdaptivePolicyRecommendation {
  return {
    recommendation_id: r.recommendation_id,
    company_id: r.company_id ?? "demo-company",
    tier: r.tier,
    current_policy: r.current_policy,
    proposed_policy: r.proposed_policy,
    changes: r.changes ?? [],
    supporting_metrics: r.supporting_metrics ?? {},
    sample_count: Number(r.sample_count ?? 0),
    unique_technician_count: Number(r.unique_technician_count ?? 0),
    confidence: Number(r.confidence ?? 0),
    explanation: r.explanation ?? "",
    limitations: r.limitations ?? [],
    included_feedback_ids: r.included_feedback_ids ?? [],
    excluded_feedback_ids: r.excluded_feedback_ids ?? [],
    status: r.status,
    created_at: toISO(r.created_at),
    approved_at: r.approved_at ? toISO(r.approved_at) : null,
    applied_at: r.applied_at ? toISO(r.applied_at) : null,
    applied_by: r.applied_by ?? null,
    previous_policy_version: r.previous_policy_version,
    new_policy_version: r.new_policy_version ?? null,
    source: r.source ?? "rule",
  };
}

export function adaptiveRecommendationToRow(r: AdaptivePolicyRecommendation) {
  return {
    recommendation_id: r.recommendation_id,
    company_id: r.company_id,
    tier: r.tier,
    current_policy: r.current_policy,
    proposed_policy: r.proposed_policy,
    changes: r.changes,
    supporting_metrics: r.supporting_metrics,
    sample_count: r.sample_count,
    unique_technician_count: r.unique_technician_count,
    confidence: r.confidence,
    explanation: r.explanation,
    limitations: r.limitations,
    included_feedback_ids: r.included_feedback_ids,
    excluded_feedback_ids: r.excluded_feedback_ids,
    status: r.status,
    created_at: r.created_at,
    approved_at: r.approved_at,
    applied_at: r.applied_at,
    applied_by: r.applied_by,
    previous_policy_version: r.previous_policy_version,
    new_policy_version: r.new_policy_version,
    source: r.source,
  };
}

export function rowToAdaptiveHistory(r: any): AdaptivePolicyChangeHistory {
  return {
    change_id: r.change_id,
    recommendation_id: r.recommendation_id ?? null,
    company_id: r.company_id ?? "demo-company",
    tier: r.tier,
    before_policy: r.before_policy,
    after_policy: r.after_policy,
    reason: r.reason,
    supporting_metrics: r.supporting_metrics ?? {},
    feedback_ids: r.feedback_ids ?? [],
    approved_by: r.approved_by ?? null,
    change_mode: r.change_mode,
    created_at: toISO(r.created_at),
    rollback_of_change_id: r.rollback_of_change_id ?? null,
  };
}

export function adaptiveHistoryToRow(h: AdaptivePolicyChangeHistory) {
  return {
    change_id: h.change_id,
    recommendation_id: h.recommendation_id,
    company_id: h.company_id,
    tier: h.tier,
    before_policy: h.before_policy,
    after_policy: h.after_policy,
    reason: h.reason,
    supporting_metrics: h.supporting_metrics,
    feedback_ids: h.feedback_ids,
    approved_by: h.approved_by,
    change_mode: h.change_mode,
    created_at: h.created_at,
    rollback_of_change_id: h.rollback_of_change_id,
  };
}

/** Defensive re-filter on read: a row's tag arrays only ever come from our
 *  own validated writes, but this keeps the mapper honest even against a
 *  hand-edited row and means the domain type's tag unions are never a lie. */
function sanitizeTagArray<T extends string>(v: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is T => (allowed as readonly string[]).includes(x));
}
