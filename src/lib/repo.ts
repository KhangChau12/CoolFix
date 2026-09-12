// ── Repository ──────────────────────────────────────────────────────
// The ONLY module that talks to the database. Agents, API routes and
// scripts call these typed functions; swapping Supabase for anything
// else is a change confined to this file + mappers.ts.
//
// All writes use the service_role client (server-side only).

import { serviceClient } from "./supabase";
import {
  approvalToRow,
  configToRow,
  decisionToRow,
  jobToRow,
  notificationToRow,
  rowToApproval,
  rowToConfig,
  rowToDecision,
  rowToJob,
  rowToNotification,
  rowToTechnician,
  technicianToRow,
} from "./mappers";
import type {
  AgentDecisionLog,
  ApprovalRequest,
  Job,
  NotificationRecord,
  RuntimeConfig,
  Technician,
} from "./types";

const sb = () => serviceClient();

function orThrow<T>(res: { data: T | null; error: unknown }, ctx: string): T {
  if (res.error) throw new Error(`[repo:${ctx}] ${JSON.stringify(res.error)}`);
  return res.data as T;
}

// ── Technicians ───────────────────────────────────────────────────

export async function listTechnicians(): Promise<Technician[]> {
  const res = await sb().from("technicians").select("*").order("name");
  return orThrow(res, "listTechnicians").map(rowToTechnician);
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
  const res = await sb().from("jobs").select("*").order("scheduled_time");
  return orThrow(res, "listJobs").map(rowToJob);
}

export async function getJob(id: string): Promise<Job | undefined> {
  const res = await sb().from("jobs").select("*").eq("job_id", id).maybeSingle();
  const row = orThrow(res, "getJob");
  return row ? rowToJob(row) : undefined;
}

export async function upsertJob(j: Job): Promise<void> {
  const res = await sb().from("jobs").upsert(jobToRow(j));
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
  const res = await sb().from("agent_decision_log").insert(decisionToRow(d));
  orThrow(res, "insertDecision");
}

export async function listDecisions(limit = 200): Promise<AgentDecisionLog[]> {
  const res = await sb()
    .from("agent_decision_log")
    .select("*")
    .order("timestamp", { ascending: false })
    .limit(limit);
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
  const res = await sb()
    .from("approval_requests")
    .select("*")
    .order("created_at", { ascending: false });
  return orThrow(res, "listApprovals").map(rowToApproval);
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
  const res = await sb()
    .from("notifications")
    .select("*")
    .order("created_at", { ascending: false });
  return orThrow(res, "listNotifications").map(rowToNotification);
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
  const res = await sb().from("runtime_config").upsert(configToRow(patch));
  orThrow(res, "updateConfig");
  return getConfig();
}

// ── Bulk reset (demo) ──────────────────────────────────────────

export async function wipeAll(): Promise<void> {
  for (const table of [
    "agent_decision_log",
    "approval_requests",
    "notifications",
    "jobs",
    "technicians",
  ]) {
    const res = await sb().from(table).delete().neq(idCol(table), "__never__");
    orThrow(res, `wipe:${table}`);
  }
}

function idCol(table: string): string {
  return (
    {
      agent_decision_log: "log_id",
      approval_requests: "approval_id",
      notifications: "notification_id",
      jobs: "job_id",
      technicians: "technician_id",
    } as Record<string, string>
  )[table];
}
