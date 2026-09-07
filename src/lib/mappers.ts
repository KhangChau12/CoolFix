// ── Row ↔ domain mappers ────────────────────────────────────────────
// snake_case Postgres rows <-> our TS domain objects. Isolated here so
// the repo and agents never touch raw row shapes.

import type {
  AgentDecisionLog,
  ApprovalRequest,
  Job,
  NotificationRecord,
  RuntimeConfig,
  Technician,
} from "./types";

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
    scoreWeights: r.score_weights ?? { w1: 1, w2: 2, w3: 1.5, w4: 1 },
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
  };
}

export function configToRow(c: Partial<RuntimeConfig>) {
  const row: Record<string, unknown> = { id: 1, updated_at: new Date().toISOString() };
  if (c.freezeWindowHours !== undefined) row.freeze_window_hours = c.freezeWindowHours;
  if (c.scoreWeights !== undefined) row.score_weights = c.scoreWeights;
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
  return row;
}

function toISO(v: unknown): string {
  if (!v) return new Date().toISOString();
  if (v instanceof Date) return v.toISOString();
  return new Date(String(v)).toISOString();
}
