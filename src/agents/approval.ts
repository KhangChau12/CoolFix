// ── Approval resolution ─────────────────────────────────────────────
// Called by the HITL screen when a coordinator clicks Approve / Reject.
// This is the human side of the reasoning loop.

import { AgentContext } from "./context";
import { logDecision } from "./log";
import {
  applyReplan,
  incomingJobClashAfterReplan,
  notifyReschedule,
} from "./orchestrator";
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

  // ── Proposal-type approval (edge-case split visit / supervised pair) ──
  // These carry no re-plan options — the agent proposed a non-standard
  // dispatch and the coordinator is confirming it will be run by hand.
  // Nothing is moved automatically; the job returns to the queue tagged
  // as coordinator-owned, with a full audit line.
  if (approval.options.length === 0) {
    const acknowledged: Job = {
      ...incoming,
      status: "pending",
      pipeline_stage: "awaiting_approval",
    };
    ctx.stageJob(acknowledged);
    await repo.resolveApproval(approval.approval_id, {
      status: "approved",
      resolved_by: input.coordinatorName,
      resolved_at: nowISO(),
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
      input: { approval_id: approval.approval_id, decision: "approve", kind: "proposal" },
      output: { result: "proposal_acknowledged" },
      headline: `${input.coordinatorName} ACCEPTED the edge-case proposal — will dispatch manually`,
      outcome: "approved",
      approvedBy: input.coordinatorName,
      guardrailNotes: [
        "Non-standard dispatch: the agent proposes, the coordinator confirms and executes — no automatic schedule change.",
      ],
    });
    await ctx.flush();
    return {
      ok: true,
      message:
        "Proposal accepted. The job stays in the queue for you to dispatch manually as agreed.",
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

  // Last-line integrity check: after the moves are applied, the incoming
  // job's slot must be clear on its technician. If the chosen option would
  // leave a collision, refuse to commit rather than double-book.
  const clash = incomingJobClashAfterReplan(ctx, approval.job_id);
  if (clash) {
    logDecision(ctx, {
      agent: "Orchestrator",
      jobId: approval.job_id,
      reasoningKind: "rule",
      input: { approval_id: approval.approval_id, decision: "approve", option: chosen.option_id },
      output: { result: "rejected_integrity_check", clashing_job: clash },
      headline: `Re-plan blocked — it would still leave ${incoming.customer_name} double-booked with job ${clash}`,
      outcome: "rejected",
      guardrailNotes: [
        "Post-apply safety check: the incoming job's slot was not clear after the re-plan — nothing was committed.",
      ],
    });
    await ctx.flush();
    return {
      ok: false,
      message: `That plan would still double-book the technician (clash with job ${clash}). Pick another option or reject.`,
      decisionLogIds: ctx.decisions.map((d) => d.log_id),
    };
  }

  // Commit the incoming job onto its technician. Re-fetch rather than reuse
  // the `incoming` captured at the top of this function: for a standard
  // disruption re-plan, `approval.job_id` was never itself one of
  // `chosen.moves`, so the two are identical there — but for a technician-
  // unavailable re-plan the affected job IS one of the moves, and
  // `applyReplan` just updated its technician/slot/freeze_point in `ctx`.
  // Using the stale pre-move `incoming` here would silently revert that
  // update while still reporting success.
  const now = nowISO();
  const target = ctx.getJob(approval.job_id) ?? incoming;
  const committed: Job = {
    ...target,
    status: isFrozen(target.freeze_point, now) ? "frozen" : "assigned",
    pipeline_stage: "assigned",
  };
  ctx.stageJob(committed);
  // `applyReplan` above already adjusted workload for any job in
  // `chosen.moves` — which, for a technician-unavailable re-plan, includes
  // the incoming job itself. Only apply the extra +1 here when it doesn't
  // (the normal disruption case: a brand-new booking, never previously
  // assigned to any technician, so nothing already credited it).
  const alreadyHandledByReplan = chosen.moves.some((m) => m.job_id === approval.job_id);
  if (committed.assigned_technician_id && !alreadyHandledByReplan) {
    ctx.stageWorkload(committed.assigned_technician_id, +1);
  }

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
  // Notify the newly-assigned incoming job — unless it was itself one of
  // `chosen.moves` (a technician-unavailable re-plan), in which case the
  // loop above already sent it a "reschedule" notification and a second,
  // contradictory "new_assignment"/"booking_confirmed" pair would just be
  // noise.
  if (!alreadyHandledByReplan) {
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
  }

  await ctx.flush();
  return {
    ok: true,
    message: `Approved "${chosen.label}". ${chosen.moves.length} appointment(s) updated, notifications sent.`,
    decisionLogIds: ctx.decisions.map((d) => d.log_id),
  };
}
