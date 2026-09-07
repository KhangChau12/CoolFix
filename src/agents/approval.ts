// ── Approval resolution ─────────────────────────────────────────────
// Called by the HITL screen when a coordinator clicks Approve / Reject.
// This is the human side of the reasoning loop.

import { AgentContext } from "./context";
import { logDecision } from "./log";
import { applyReplan, notifyReschedule } from "./orchestrator";
import { runNotificationAgent } from "./notification";
import * as repo from "@/lib/repo";
import { computeFreezePoint, isFrozen, nowISO } from "@/lib/time";
import type { Job } from "@/lib/types";

export interface ResolveInput {
  approvalId: string;
  decision: "approve" | "reject";
  chosenOptionId?: string;
  coordinatorName: string;
}

export interface ResolveResult {
  ok: boolean;
  message: string;
  decisionLogIds: string[];
}

export async function resolveApproval(input: ResolveInput): Promise<ResolveResult> {
  const approval = await repo.getApproval(input.approvalId);
  if (!approval) return { ok: false, message: "Approval request not found", decisionLogIds: [] };
  if (approval.status !== "pending")
    return { ok: false, message: `Request already ${approval.status}`, decisionLogIds: [] };

  const ctx = await AgentContext.create();
  const incoming = ctx.getJob(approval.job_id);
  if (!incoming) return { ok: false, message: "Job not found", decisionLogIds: [] };

  if (input.decision === "reject") {
    // Coordinator declined the re-plan → the incoming job cannot take the
    // slot. Leave it pending for manual handling; touch nothing else.
    const rejected: Job = { ...incoming, status: "pending", pipeline_stage: "awaiting_approval" };
    ctx.stageJob(rejected);

    await repo.resolveApproval(approval.approval_id, {
      status: "rejected",
      resolved_by: input.coordinatorName,
      resolved_at: nowISO(),
    });
    await repo.updateDecisionApproval(
      approval.disruption_log_id,
      input.coordinatorName,
      "rejected",
    );

    logDecision(ctx, {
      agent: "Orchestrator",
      jobId: approval.job_id,
      reasoningKind: "rule",
      input: { approval_id: approval.approval_id, decision: "reject" },
      output: { result: "replan_rejected" },
      headline: `${input.coordinatorName} REJECTED the re-plan — existing schedule kept`,
      outcome: "rejected",
      approvedBy: input.coordinatorName,
      guardrailNotes: ["The human can veto the agent — the human's decision is respected absolutely."],
    });
    await ctx.flush();
    return {
      ok: true,
      message: "Rejected. The new job stays in the queue; no existing appointment was changed.",
      decisionLogIds: ctx.decisions.map((d) => d.log_id),
    };
  }

  // approve
  const optionId = input.chosenOptionId ?? approval.options.find((o) => o.recommended)?.option_id;
  const chosen = approval.options.find((o) => o.option_id === optionId);
  if (!chosen) return { ok: false, message: "Invalid option", decisionLogIds: [] };

  const reason =
    approval.kind === "emergency_override"
      ? "Emergency Override approved by the coordinator"
      : "Re-plan approved by the coordinator";

  applyReplan(ctx, chosen.option_id, approval.options, input.coordinatorName, reason);

  // Commit the incoming job onto its technician.
  const now = nowISO();
  const committed: Job = {
    ...incoming,
    status: isFrozen(incoming.freeze_point, now) ? "frozen" : "assigned",
    pipeline_stage: "assigned",
  };
  ctx.stageJob(committed);
  if (committed.assigned_technician_id) ctx.stageWorkload(committed.assigned_technician_id, +1);

  await repo.resolveApproval(approval.approval_id, {
    status: "approved",
    chosen_option_id: chosen.option_id,
    resolved_by: input.coordinatorName,
    resolved_at: now,
  });
  await repo.updateDecisionApproval(
    approval.disruption_log_id,
    input.coordinatorName,
    "approved",
  );

  logDecision(ctx, {
    agent: "Orchestrator",
    jobId: approval.job_id,
    reasoningKind: "rule",
    input: {
      approval_id: approval.approval_id,
      decision: "approve",
      option: chosen.option_id,
      kind: approval.kind,
    },
    output: { result: "replan_approved", moves: chosen.moves.length },
    headline: `${input.coordinatorName} APPROVED ${
      approval.kind === "emergency_override" ? "Emergency Override" : "re-plan"
    }: ${chosen.label}`,
    outcome: "approved",
    approvedBy: input.coordinatorName,
    replanOptions: approval.options,
    guardrailNotes: [
      approval.kind === "emergency_override"
        ? "Emergency Override: every change to a frozen job carries the approver's name in the log."
        : "Re-plan approved by a human — full audit trail.",
    ],
  });

  // Notify the moved customers/technicians.
  for (const move of chosen.moves) {
    const tn = await runNotificationAgent(ctx, {
      jobId: move.job_id,
      channel: "technician_app",
      kind: "reschedule",
      change: { fromISO: move.from_time, toISO: move.to_time, reason },
    });
    ctx.bufferNotification(tn);
    const cn = await runNotificationAgent(ctx, {
      jobId: move.job_id,
      channel: "customer_email",
      kind: "reschedule",
      change: { fromISO: move.from_time, toISO: move.to_time, reason },
    });
    ctx.bufferNotification(cn);
  }
  // Notify the newly-assigned incoming job.
  const newTn = await runNotificationAgent(ctx, {
    jobId: approval.job_id,
    channel: "technician_app",
    kind: "new_assignment",
  });
  ctx.bufferNotification(newTn);
  const newCn = await runNotificationAgent(ctx, {
    jobId: approval.job_id,
    channel: "customer_email",
    kind: "booking_confirmed",
  });
  ctx.bufferNotification(newCn);

  await ctx.flush();
  return {
    ok: true,
    message: `Approved "${chosen.label}". ${chosen.moves.length} appointment(s) updated, notifications sent.`,
    decisionLogIds: ctx.decisions.map((d) => d.log_id),
  };
}
