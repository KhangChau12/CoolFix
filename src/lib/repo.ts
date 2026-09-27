// ── Repository ──────────────────────────────────────────────────────
// The ONLY module that talks to the database. Agents, API routes and
// scripts call these typed functions; swapping Supabase for anything
// else is a change confined to this file + mappers.ts.
//
// All writes use the service_role client (server-side only).

import { serviceClient } from "./supabase";
import {
  approvalToRow,
  adaptiveHistoryToRow,
  adaptiveRecommendationToRow,
  configToRow,
  decisionToRow,
  feedbackToRow,
  jobToRow,
  notificationToRow,
  rowToApproval,
  rowToAdaptiveHistory,
  rowToAdaptiveRecommendation,
  rowToConfig,
  rowToDecision,
  rowToFeedback,
  rowToJob,
  rowToNotification,
  rowToTechnician,
  technicianToRow,
} from "./mappers";
import type {
  AgentDecisionLog,
  ApprovalRequest,
  AdaptivePolicyChangeHistory,
  AdaptivePolicyRecommendation,
  Job,
  JobFeedback,
  NotificationRecord,
  RuntimeConfig,
  Technician,
} from "./types";

const sb = () => serviceClient();

function orThrow<T>(res: { data: T | null; error: unknown }, ctx: string): T {
  if (res.error) throw new Error(`[repo:${ctx}] ${JSON.stringify(res.error)}`);
  return res.data as T;
}

/** PostgREST caps each response; scheduling and rating inputs must include
 * every row, not only the first page. Callers provide a stable unique order. */
async function allRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown; count: number | null }>,
  ctx: string,
  optionalTable = false,
): Promise<T[]> {
  const rows: T[] = [];
  for (;;) {
    const res = await page(rows.length, rows.length + 499);
    if (optionalTable && res.error && isMissingTableError(res.error)) return [];
    const batch = orThrow(res, ctx) ?? [];
    rows.push(...batch);
    if (!batch.length || (res.count !== null && rows.length >= res.count)) return rows;
  }
}

// ── Technicians ───────────────────────────────────────────────────

export async function listTechnicians(): Promise<Technician[]> {
  const rows = await allRows((from, to) => sb().from("technicians").select("*", { count: "exact" })
    .order("name").order("technician_id").range(from, to), "listTechnicians");
  return rows.map(rowToTechnician);
}

export async function getTechnician(id: string): Promise<Technician | undefined> {
  const res = await sb().from("technicians").select("*").eq("technician_id", id).maybeSingle();
  const row = orThrow(res, "getTechnician");
  return row ? rowToTechnician(row) : undefined;
}

export async function upsertTechnician(t: Technician): Promise<void> {
  const res = await sb().from("technicians").upsert(technicianToRow(t));
  orThrow(res, "upsertTechnician");
}

export async function setTechnicianWorkload(id: string, workload: number): Promise<void> {
  const res = await sb()
    .from("technicians")
    .update({ current_workload: Math.max(0, workload) })
    .eq("technician_id", id);
  orThrow(res, "setTechnicianWorkload");
}

// ── Jobs ──────────────────────────────────────────────────────────

export async function listJobs(): Promise<Job[]> {
  const rows = await allRows((from, to) => sb().from("jobs").select("*", { count: "exact" })
    .order("scheduled_time").order("job_id").range(from, to), "listJobs");
  return rows.map(rowToJob);
}

export async function getJob(id: string): Promise<Job | undefined> {
  const res = await sb().from("jobs").select("*").eq("job_id", id).maybeSingle();
  const row = orThrow(res, "getJob");
  return row ? rowToJob(row) : undefined;
}

export async function upsertJob(j: Job): Promise<void> {
  const row = jobToRow(j);
  let res = await sb().from("jobs").upsert(row);
  if (res.error && hasMissingPolicySnapshotColumn(res.error)) {
    const { dispatch_policy_version: _version, dispatch_policy_snapshot: _snapshot, ...legacyRow } = row;
    res = await sb().from("jobs").upsert(legacyRow);
  }
  orThrow(res, "upsertJob");
}

/** The ONLY lookup path for the public customer tracker — by tracking
 *  token, never by job_id. Callers must not fall back to `getJob` with the
 *  same input; see `/api/public/jobs/[token]`. */
export async function getJobByTrackingToken(token: string): Promise<Job | undefined> {
  const res = await sb()
    .from("jobs")
    .select("*")
    .eq("public_tracking_token", token)
    .maybeSingle();
  const row = orThrow(res, "getJobByTrackingToken");
  return row ? rowToJob(row) : undefined;
}

// ── Decision log ─────────────────────────────────────────────────

export async function insertDecision(d: AgentDecisionLog): Promise<void> {
  const row = decisionToRow(d);
  let res = await sb().from("agent_decision_log").insert(row);
  if (res.error && hasMissingPolicySnapshotColumn(res.error)) {
    const { policy_version: _version, dispatch_policy_snapshot: _snapshot, ...legacyRow } = row;
    res = await sb().from("agent_decision_log").insert(legacyRow);
  }
  orThrow(res, "insertDecision");
}

export async function listDecisions(limit = 200, jobId?: string): Promise<AgentDecisionLog[]> {
  let query = sb()
    .from("agent_decision_log")
    .select("*")
    .order("timestamp", { ascending: false })
    .order("log_id")
    .limit(limit);
  // Filter before applying the feed limit so older jobs still have replay
  // history even when hundreds of newer decisions exist for other jobs.
  if (jobId) query = query.eq("job_id", jobId);
  const res = await query;
  return orThrow(res, "listDecisions").map(rowToDecision);
}

export async function updateDecisionApproval(
  logId: string,
  approvedBy: string,
  outcome: "approved" | "rejected",
): Promise<void> {
  const res = await sb()
    .from("agent_decision_log")
    .update({ approved_by: approvedBy, outcome })
    .eq("log_id", logId);
  orThrow(res, "updateDecisionApproval");
}

// ── Approvals ────────────────────────────────────────────────────

export async function insertApproval(a: ApprovalRequest): Promise<void> {
  const res = await sb().from("approval_requests").insert(approvalToRow(a));
  orThrow(res, "insertApproval");
}

export async function listApprovals(): Promise<ApprovalRequest[]> {
  const rows = await allRows((from, to) => sb()
    .from("approval_requests")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false }).order("approval_id").range(from, to), "listApprovals");
  return rows.map(rowToApproval);
}

export async function getApproval(id: string): Promise<ApprovalRequest | undefined> {
  const res = await sb()
    .from("approval_requests")
    .select("*")
    .eq("approval_id", id)
    .maybeSingle();
  const row = orThrow(res, "getApproval");
  return row ? rowToApproval(row) : undefined;
}

export async function resolveApproval(
  id: string,
  patch: Partial<ApprovalRequest>,
): Promise<void> {
  const res = await sb()
    .from("approval_requests")
    .update({
      status: patch.status,
      chosen_option_id: patch.chosen_option_id ?? null,
      resolved_by: patch.resolved_by ?? null,
      resolved_at: patch.resolved_at ?? new Date().toISOString(),
    })
    .eq("approval_id", id);
  orThrow(res, "resolveApproval");
}

// ── Notifications ────────────────────────────────────────────────

export async function insertNotification(n: NotificationRecord): Promise<void> {
  const res = await sb().from("notifications").insert(notificationToRow(n));
  orThrow(res, "insertNotification");
}

export async function listNotifications(): Promise<NotificationRecord[]> {
  const rows = await allRows((from, to) => sb()
    .from("notifications")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false }).order("notification_id").range(from, to), "listNotifications");
  return rows.map(rowToNotification);
}

export async function ackNotification(id: string): Promise<void> {
  const res = await sb()
    .from("notifications")
    .update({ acknowledged: true, acknowledged_at: new Date().toISOString() })
    .eq("notification_id", id);
  orThrow(res, "ackNotification");
}

// ── Config ──────────────────────────────────────────────────────

export async function getConfig(): Promise<RuntimeConfig> {
  const res = await sb().from("runtime_config").select("*").eq("id", 1).maybeSingle();
  const row = orThrow(res, "getConfig");
  return rowToConfig(row ?? {});
}

export async function updateConfig(patch: Partial<RuntimeConfig>): Promise<RuntimeConfig> {
  // Clear legacy overrides on every write, including updates from old tabs.
  const effectivePatch = { ...patch, clockMode: "real" as const, customTimeISO: null };
  let current: RuntimeConfig | null = null;
  if (patch.dispatchPolicy !== undefined) {
    current = await getConfig();
    effectivePatch.policyVersion = nextPolicyVersion(current.policyVersion);
  } else {
    // policy_version is server-owned; unrelated settings must not accept a
    // browser-supplied version string.
    delete effectivePatch.policyVersion;
  }
  const row = configToRow(effectivePatch);
  let res = await sb().from("runtime_config").upsert(row);

  // PostgREST reports only one missing column at a time. An older database
  // can lack both migrations 0007 and 0008; remember each missing group
  // across bounded retries instead of reintroducing the previous failure.
  let missingClock = false;
  let missingAdaptive = false;
  for (let retry = 0; res.error && retry < 2; retry++) {
    if (hasMissingClockColumn(res.error) && !missingClock) missingClock = true;
    else if (hasMissingAdaptiveConfigColumn(res.error) && !missingAdaptive) missingAdaptive = true;
    else break;
    const fallbackPatch = { ...effectivePatch };
    if (missingClock) {
      current ??= await getConfig();
      fallbackPatch.dispatchPolicy ??= current.dispatchPolicy;
    }
    const fallbackRow = configToRow(fallbackPatch, { embedClockFallback: missingClock });
    if (missingClock) {
      delete fallbackRow.clock_mode;
      delete fallbackRow.custom_time_iso;
    }
    if (missingAdaptive) {
      for (const key of [
        "policy_version",
        "adaptive_policy_enabled",
        "adaptive_policy_mode",
        "adaptive_min_feedback_count",
        "adaptive_min_unique_technicians",
        "adaptive_max_change",
        "adaptive_cooldown_days",
        "adaptive_min_confidence",
        "adaptive_max_customer_satisfaction_weight",
      ]) delete fallbackRow[key];
    }
    res = await sb().from("runtime_config").upsert(fallbackRow);
  }

  orThrow(res, "updateConfig");
  return getConfig();
}

function nextPolicyVersion(current: string): string {
  const match = /^policy-v(\d+)$/.exec(current);
  return `policy-v${match ? Number(match[1]) + 1 : Date.now()}`;
}

/** Update only if the caller still holds the policy version it analyzed. */
export async function updateConfigForPolicyVersion(
  patch: Partial<RuntimeConfig>,
  expectedVersion: string,
  nextVersion: string,
): Promise<RuntimeConfig | null> {
  const row = configToRow({ ...patch, policyVersion: nextVersion });
  const res = await sb()
    .from("runtime_config")
    .update(row)
    .eq("id", 1)
    .eq("policy_version", expectedVersion)
    .select()
    .maybeSingle();
  if (res.error) throw new Error(`[repo:updateConfigForPolicyVersion] ${JSON.stringify(res.error)}`);
  return res.data ? rowToConfig(res.data) : null;
}

function hasMissingClockColumn(error: unknown): boolean {
  const text = JSON.stringify(error) ?? String(error);
  return text.includes("PGRST204") &&
    (text.includes("clock_mode") || text.includes("custom_time_iso"));
}

function hasMissingAdaptiveConfigColumn(error: unknown): boolean {
  const text = JSON.stringify(error) ?? String(error);
  return text.includes("PGRST204") && /(policy_version|adaptive_)/.test(text);
}

function hasMissingPolicySnapshotColumn(error: unknown): boolean {
  const text = JSON.stringify(error) ?? String(error);
  return text.includes("PGRST204") && /(dispatch_policy_version|dispatch_policy_snapshot|policy_version)/.test(text);
}

// ── Job feedback ───────────────────────────────────────────────

export type InsertFeedbackResult =
  | { ok: true; feedback: JobFeedback }
  | { ok: false; reason: "duplicate" | "unavailable" };

/**
 * Insert a feedback row, treating a unique-constraint violation on job_id
 * as an expected outcome (someone else's concurrent submission won the
 * race) rather than an error — this is the actual duplicate-submission
 * guard (job_feedback_job_id_idx, migration 0006), not just the
 * "does feedback already exist" pre-check the API route also does. Two
 * requests racing each other can both pass that pre-check; only one can
 * win this insert.
 *
 * Also treats "the table doesn't exist yet" (migration 0006 not applied)
 * as a clean `{ok:false, reason:"unavailable"}` rather than an uncaught
 * throw — this is called from demo seeding (reset/seed scripts) as well as
 * the live customer-facing route, and neither should hard-crash an
 * otherwise-working environment that just hasn't run that migration yet.
 */
export async function insertFeedbackIfAbsent(f: JobFeedback): Promise<InsertFeedbackResult> {
  let row = feedbackToRow(f);
  let res = await sb().from("job_feedback").insert(row).select().maybeSingle();
  // Keep the original feedback flow readable while migration 0008 is being
  // rolled out. Adaptive moderation fields are optional at this boundary;
  // the database unique index from 0006 remains the duplicate guard.
  if (res.error && isMissingAdaptiveFeedbackColumn(res.error)) {
    const { source_hash: _sourceHash, flagged: _flagged, excluded_from_adaptation: _excluded, flag_reason: _reason, ...legacyRow } = row;
    res = await sb().from("job_feedback").insert(legacyRow).select().maybeSingle();
  }
  if (res.error) {
    const code = (res.error as { code?: string }).code;
    if (code === "23505") return { ok: false, reason: "duplicate" };
    if (isMissingTableError(res.error)) return { ok: false, reason: "unavailable" };
    throw new Error(`[repo:insertFeedbackIfAbsent] ${JSON.stringify(res.error)}`);
  }
  return { ok: true, feedback: f };
}

function isMissingAdaptiveFeedbackColumn(error: unknown): boolean {
  const text = JSON.stringify(error) ?? String(error);
  return text.includes("PGRST204") && /(source_hash|flagged|excluded_from_adaptation|flag_reason)/.test(text);
}

/** True if a Supabase/PostgREST error means "the table doesn't exist" —
 *  specifically migration 0006 not having been applied yet in this
 *  environment. Every READ path below treats that as "no feedback exists",
 *  not a crash: the booking pipeline (AgentContext loads feedback on every
 *  run), the technicians admin page, and the tracking page must all keep
 *  working before that migration lands, exactly as they did before this
 *  feature existed. Writing feedback still requires the real table. */
function isMissingTableError(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "PGRST205";
}

export async function getFeedbackByJobId(jobId: string): Promise<JobFeedback | undefined> {
  const res = await sb().from("job_feedback").select("*").eq("job_id", jobId).maybeSingle();
  if (res.error) {
    if (isMissingTableError(res.error)) return undefined;
    orThrow(res, "getFeedbackByJobId");
  }
  return res.data ? rowToFeedback(res.data) : undefined;
}

/** Every feedback row, for aggregation (technician performance, scoring's
 *  customerSatisfaction component). Small demo-scale dataset — loaded
 *  wholesale and summarised in memory, same convention as
 *  `listJobs`/`listTechnicians`. */
export async function listFeedback(): Promise<JobFeedback[]> {
  const rows = await allRows((from, to) => sb().from("job_feedback").select("*", { count: "exact" })
    .order("created_at", { ascending: false }).order("feedback_id").range(from, to), "listFeedback", true);
  return rows.map(rowToFeedback);
}

export async function listFeedbackForTechnician(technicianId: string): Promise<JobFeedback[]> {
  const rows = await allRows((from, to) => sb()
    .from("job_feedback")
    .select("*", { count: "exact" })
    .eq("technician_id", technicianId)
    .order("created_at", { ascending: false }).order("feedback_id").range(from, to), "listFeedbackForTechnician", true);
  return rows.map(rowToFeedback);
}

export async function updateFeedbackModeration(
  feedbackId: string,
  patch: { flagged: boolean; excluded_from_adaptation: boolean; flag_reason: string | null },
): Promise<void> {
  const res = await sb().from("job_feedback").update(patch).eq("feedback_id", feedbackId);
  orThrow(res, "updateFeedbackModeration");
}

export async function countRecentFeedbackAttempts(
  where: { trackingTokenHash?: string; sourceHash?: string; sessionHash?: string },
  sinceISO: string,
): Promise<number> {
  let query = sb().from("feedback_submission_attempts").select("attempt_id", { count: "exact", head: true }).gte("created_at", sinceISO);
  if (where.trackingTokenHash) query = query.eq("tracking_token_hash", where.trackingTokenHash);
  if (where.sourceHash) query = query.eq("source_hash", where.sourceHash);
  if (where.sessionHash) query = query.eq("session_hash", where.sessionHash);
  const res = await query;
  if (res.error) {
    if (isMissingTableError(res.error)) return 0;
    orThrow(res, "countRecentFeedbackAttempts");
  }
  return res.count ?? 0;
}

export async function insertFeedbackAttempt(attempt: {
  attempt_id: string;
  tracking_token_hash: string;
  source_hash: string;
  session_hash: string | null;
  created_at: string;
}): Promise<void> {
  const res = await sb().from("feedback_submission_attempts").insert(attempt);
  if (res.error && !isMissingTableError(res.error)) orThrow(res, "insertFeedbackAttempt");
}

export async function listAdaptiveRecommendations(limit = 50): Promise<AdaptivePolicyRecommendation[]> {
  const res = await sb()
    .from("adaptive_policy_recommendations")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  return orThrow(res, "listAdaptiveRecommendations").map(rowToAdaptiveRecommendation);
}

export async function getAdaptiveRecommendation(id: string): Promise<AdaptivePolicyRecommendation | undefined> {
  const res = await sb().from("adaptive_policy_recommendations").select("*").eq("recommendation_id", id).maybeSingle();
  const row = orThrow(res, "getAdaptiveRecommendation");
  return row ? rowToAdaptiveRecommendation(row) : undefined;
}

export async function insertAdaptiveRecommendation(r: AdaptivePolicyRecommendation): Promise<void> {
  const res = await sb().from("adaptive_policy_recommendations").insert(adaptiveRecommendationToRow(r));
  orThrow(res, "insertAdaptiveRecommendation");
}

export async function updateAdaptiveRecommendation(
  id: string,
  patch: Partial<AdaptivePolicyRecommendation>,
): Promise<AdaptivePolicyRecommendation | undefined> {
  const row: Record<string, unknown> = {};
  for (const key of [
    "status", "approved_at", "applied_at", "applied_by", "new_policy_version",
  ] as const) {
    if (patch[key] !== undefined) row[key] = patch[key];
  }
  const res = await sb().from("adaptive_policy_recommendations").update(row).eq("recommendation_id", id).select().maybeSingle();
  const result = orThrow(res, "updateAdaptiveRecommendation");
  return result ? rowToAdaptiveRecommendation(result) : undefined;
}

export async function insertAdaptiveHistory(h: AdaptivePolicyChangeHistory): Promise<void> {
  const res = await sb().from("adaptive_policy_change_history").insert(adaptiveHistoryToRow(h));
  orThrow(res, "insertAdaptiveHistory");
}

export async function listAdaptiveHistory(limit = 50): Promise<AdaptivePolicyChangeHistory[]> {
  const res = await sb().from("adaptive_policy_change_history").select("*").order("created_at", { ascending: false }).limit(limit);
  return orThrow(res, "listAdaptiveHistory").map(rowToAdaptiveHistory);
}

// ── Bulk reset (demo) ──────────────────────────────────────────

export async function wipeAll(): Promise<void> {
  for (const table of [
    // job_feedback references jobs + technicians (FK) — must go first.
    "job_feedback",
    "feedback_submission_attempts",
    "adaptive_policy_change_history",
    "adaptive_policy_recommendations",
    "agent_decision_log",
    "approval_requests",
    "notifications",
    "jobs",
    "technicians",
  ]) {
    const res = await sb().from(table).delete().neq(idCol(table), "__never__");
    if (res.error) {
      // job_feedback is the one table introduced after the rest of this
      // app's DB shipped (migration 0006). Don't let an environment that
      // hasn't run that migration yet lose the reset/seed workflow
      // entirely over a table it doesn't have rows in anyway.
      const code = (res.error as { code?: string }).code;
      if (["job_feedback", "feedback_submission_attempts", "adaptive_policy_change_history", "adaptive_policy_recommendations"].includes(table) && code === "PGRST205") continue;
      orThrow(res, `wipe:${table}`);
    }
  }
}

function idCol(table: string): string {
  return (
    {
      job_feedback: "feedback_id",
      feedback_submission_attempts: "attempt_id",
      adaptive_policy_change_history: "change_id",
      adaptive_policy_recommendations: "recommendation_id",
      agent_decision_log: "log_id",
      approval_requests: "approval_id",
      notifications: "notification_id",
      jobs: "job_id",
      technicians: "technician_id",
    } as Record<string, string>
  )[table];
}
