// ── Orchestrator ────────────────────────────────────────────────────
// The reasoning loop. Runs the pipeline from CLAUDE.md §4 for one
// booking, wiring typed outputs from each agent into the next, deciding
// auto-commit vs. HITL, and flushing all state + logs at the end.
//
//   Pricing → Intake → Capacity → Technician-State → Assignment
//     ├─ no conflict ─────────────→ commit + notify
//     └─ conflict ─→ Disruption ─→ auto-commit + notify
//                              └─→ HITL approval gate (stop here)

import { AgentContext } from "./context";
import { logDecision } from "./log";
import { runPricingEngine } from "./pricing";
import { runJobIntakeAgent } from "./jobIntake";
import { runCapacityAgent } from "./capacity";
import { runTechnicianStateAgent } from "./technicianState";
import { runAssignmentAgent } from "./assignment";
import { runDisruptionAgent } from "./disruption";
import { runNotificationAgent } from "./notification";
import {
  validateBookingRequest,
  type BookingRequest,
} from "./schemas";
import {
  addHours,
  computeFreezePoint,
  isFrozen,
  nowISO,
  snapToServiceHours,
} from "@/lib/time";
import { CATEGORY_HINT_SKILL, type ApprovalRequest, type Job } from "@/lib/types";

export interface PipelineResult {
  job: Job;
  status:
    | "assigned_auto"
    | "assigned_after_replan"
    | "awaiting_approval"
    | "capacity_alternative"
    | "unassignable";
  approval?: ApprovalRequest;
  decisionLogIds: string[];
  notificationsSent: number;
  llmCalls: number;
  message: string;
}

export async function runBookingPipeline(
  rawBooking: unknown,
): Promise<PipelineResult> {
  const booking: BookingRequest = validateBookingRequest(rawBooking);
  const ctx = await AgentContext.create();
  const now = nowISO();
  const jobId = `job_${Date.now().toString(36)}`;

  logDecision(ctx, {
    agent: "Orchestrator",
    jobId,
    reasoningKind: "rule",
    input: { tier: booking.tier, category: booking.problem_category },
    output: { pipeline: "start" },
    headline: `New booking received (${booking.customer_name}, ${booking.tier})`,
    outcome: "info",
    guardrailNotes: ["Booking passed schema validation (least-privilege, oversize-guarded)."],
  });

  // ── 1. Pricing (rule) ───────────────────────────────────────────
  // Skill not known yet → price on the dropdown hint, re-price after intake.
  const hintSkill = CATEGORY_HINT_SKILL[booking.problem_category] ?? "basic_maintenance";
  let pricing = runPricingEngine(ctx, {
    jobId,
    skillRequired: [hintSkill],
    tier: booking.tier,
  });

  // ── 2. Job-Intake (LLM) ─────────────────────────────────────────
  const intake = await runJobIntakeAgent(ctx, jobId, booking);

  // Re-price now that we know the real required skills.
  pricing = runPricingEngine(ctx, {
    jobId,
    skillRequired: intake.skill_required,
    tier: booking.tier,
  });

  // ── 3. Capacity (rule) ──────────────────────────────────────────
  const [earliest, latest] = intake.time_window_hours;
  let slotHours = clampSlot(booking.tier, earliest, latest);
  const capacity = runCapacityAgent(ctx, {
    jobId,
    tier: booking.tier,
    proposedSlotHours: slotHours,
  });

  if (capacity.decision === "suggest_alternative_slot" && capacity.alternative_slot_hours) {
    slotHours = capacity.alternative_slot_hours;
  }

  // Snap to a slot inside common service hours so scoring isn't handed
  // an appointment every technician would reject as off-hours.
  const scheduledTime = snapToServiceHours(now, slotHours);
  const freezePoint = computeFreezePoint(scheduledTime, ctx.config.freezeWindowHours);

  // Stage the job so later agents (clash detection) see it.
  let job: Job = {
    job_id: jobId,
    customer_name: booking.customer_name,
    customer_email: booking.customer_email,
    customer_phone: booking.customer_phone,
    location: { ...booking.location, address: booking.address },
    problem_description: booking.problem_description,
    problem_category: booking.problem_category,
    photo_url: booking.photo_url,
    skill_required: intake.skill_required,
    tier: booking.tier,
    scheduled_time: scheduledTime,
    freeze_point: freezePoint,
    status: "pending",
    assigned_technician_id: null,
    score_breakdown: null,
    price: pricing.price,
    created_at: now,
    pipeline_stage: "scoring",
    reschedule_history: [],
  };
  ctx.stageJob(job);

  if (capacity.decision === "suggest_alternative_slot") {
    // We accepted at a later slot; continue assigning at that slot.
  }

  // ── 4. Technician-State (rule) ──────────────────────────────────
  const techState = runTechnicianStateAgent(ctx, {
    jobId,
    scheduledTime,
  });

  // ── 5. Assignment / Scoring (rule) ─────────────────────────────
  const assignment = runAssignmentAgent(ctx, {
    jobId,
    jobLocation: booking.location,
    skillRequired: intake.skill_required,
    tier: booking.tier,
    urgencyHint: intake.urgency_hint,
    scheduledTime,
    techState,
  });

  const decisionLogIds = () => ctx.decisions.map((d) => d.log_id);

  // 5a. Unassignable — needs human / edge-case handling.
  if (!assignment.assigned_technician_id) {
    job = { ...job, status: "pending", pipeline_stage: "awaiting_approval" };
    ctx.stageJob(job);
    logDecision(ctx, {
      agent: "Orchestrator",
      jobId,
      reasoningKind: "rule",
      input: { eligible: 0 },
      output: { result: "unassignable" },
      headline: "No technician found — coordinator needs to handle manually",
      outcome: "requires_approval",
      requiresApproval: true,
      guardrailNotes: ["Stops at the right point: never forces a job onto an uncertified technician."],
    });
    await ctx.flush();
    return {
      job,
      status: "unassignable",
      decisionLogIds: decisionLogIds(),
      notificationsSent: 0,
      llmCalls: countLlm(ctx),
      message: "No eligible technician. Escalated to the coordinator.",
    };
  }

  // 5b. Clean assignment, no conflict → auto-commit.
  if (!assignment.conflict) {
    job = {
      ...job,
      status: isFrozen(freezePoint, now) ? "frozen" : "assigned",
      assigned_technician_id: assignment.assigned_technician_id,
      score_breakdown: assignment.score_breakdown,
      pipeline_stage: "assigned",
    };
    ctx.stageJob(job);
    ctx.stageWorkload(assignment.assigned_technician_id, +1);

    await notifyAssignment(ctx, jobId);

    logDecision(ctx, {
      agent: "Orchestrator",
      jobId,
      reasoningKind: "rule",
      input: { conflict: false },
      output: { result: "assigned_auto", technician: assignment.assigned_technician_id },
      headline: "Auto-commit: technician assigned, no schedule conflict",
      outcome: "auto_commit",
      guardrailNotes: ["Zero impact on other jobs → full autonomy, no human approval needed."],
    });

    await ctx.flush();
    return {
      job,
      status: "assigned_auto",
      decisionLogIds: decisionLogIds(),
      notificationsSent: ctx.notifications.length,
      llmCalls: countLlm(ctx),
      message: `Assigned ${ctx.getTechnician(assignment.assigned_technician_id)?.name}. Scheduled for ${scheduledTime}.`,
    };
  }

  // 5c. Conflict → Disruption Agent.
  const disruption = await runDisruptionAgent(ctx, {
    incomingJobId: jobId,
    assignment,
  });

  if (!disruption.needsApproval && disruption.autoChosenOptionId) {
    // Low impact → auto-commit the recommended re-plan.
    applyReplan(
      ctx,
      disruption.autoChosenOptionId,
      disruption.options,
      "auto",
      "Urgent job took priority",
    );
    job = {
      ...job,
      status: "assigned",
      assigned_technician_id: assignment.assigned_technician_id,
      score_breakdown: assignment.score_breakdown,
      pipeline_stage: "assigned",
    };
    ctx.stageJob(job);
    ctx.stageWorkload(assignment.assigned_technician_id, +1);

    await notifyAssignment(ctx, jobId);
    await notifyReschedule(ctx, disruption, "Urgent job took priority");

    logDecision(ctx, {
      agent: "Orchestrator",
      jobId,
      reasoningKind: "rule",
      input: { conflict: true, approval: false },
      output: { result: "assigned_after_replan" },
      headline: "Auto-commit re-plan (low impact)",
      outcome: "auto_commit",
    });

    await ctx.flush();
    return {
      job,
      status: "assigned_after_replan",
      decisionLogIds: decisionLogIds(),
      notificationsSent: ctx.notifications.length,
      llmCalls: countLlm(ctx),
      message: "Technician assigned; one low-impact job was moved automatically.",
    };
  }

  // 5d. High impact or frozen job → HITL approval gate. STOP here.
  const approval: ApprovalRequest = {
    approval_id: `apr_${Date.now().toString(36)}`,
    created_at: nowISO(),
    kind: disruption.approvalKind,
    job_id: jobId,
    reason:
      disruption.approvalKind === "emergency_override"
        ? "The re-plan touches a job past its freeze point (schedule locked). Coordinator approval is mandatory."
        : "The re-plan exceeds the allowed impact threshold (customers affected / added travel / SLA breach).",
    disruption_log_id: disruption.logId,
    options: disruption.options,
    chosen_option_id: null,
    status: "pending",
    resolved_by: null,
    resolved_at: null,
    frozen_jobs_impacted: disruption.frozenJobsImpacted,
  };
  ctx.bufferApproval(approval);

  job = {
    ...job,
    status: "pending",
    // Hold the intended technician on the job so the approval screen can show it.
    assigned_technician_id: assignment.assigned_technician_id,
    score_breakdown: assignment.score_breakdown,
    pipeline_stage: "awaiting_approval",
  };
  ctx.stageJob(job);

  logDecision(ctx, {
    agent: "Orchestrator",
    jobId,
    reasoningKind: "rule",
    input: { conflict: true, approval: true, kind: disruption.approvalKind },
    output: { result: "awaiting_approval", approval_id: approval.approval_id },
    headline:
      disruption.approvalKind === "emergency_override"
        ? "⛔ Paused for approval — Emergency Override (frozen job)"
        : "⏸ Paused — coordinator must approve the re-plan",
    outcome: "requires_approval",
    requiresApproval: true,
    guardrailNotes: [
      "Risk-calibrated autonomy: high risk → the system does NOT act on its own, it waits for a human.",
    ],
  });

  await ctx.flush();
  return {
    job,
    status: "awaiting_approval",
    approval,
    decisionLogIds: decisionLogIds(),
    notificationsSent: 0,
    llmCalls: countLlm(ctx),
    message:
      disruption.approvalKind === "emergency_override"
        ? "Emergency Override required: the re-plan touches a frozen job. Awaiting approval."
        : "The re-plan needs coordinator approval. Awaiting.",
  };
}

// ── Applying an approved / auto re-plan ────────────────────────────

export function applyReplan(
  ctx: AgentContext,
  optionId: string,
  options: ApprovalRequest["options"],
  decidedBy: string,
  reason: string,
): void {
  const opt = options.find((o) => o.option_id === optionId);
  if (!opt) throw new Error(`Unknown replan option: ${optionId}`);
  const at = nowISO();
  for (const move of opt.moves) {
    const target = ctx.getJob(move.job_id);
    if (!target) continue;
    const prevTech = target.assigned_technician_id;
    const updated: Job = {
      ...target,
      scheduled_time: move.to_time,
      freeze_point: computeFreezePoint(move.to_time, ctx.config.freezeWindowHours),
      assigned_technician_id: move.technician_id,
      status: "assigned",
      reschedule_history: [
        ...target.reschedule_history,
        {
          at,
          from_time: move.from_time,
          to_time: move.to_time,
          reason,
          decided_by: decidedBy,
        },
      ],
    };
    ctx.stageJob(updated);
    if (prevTech && prevTech !== move.technician_id) {
      ctx.stageWorkload(prevTech, -1);
      ctx.stageWorkload(move.technician_id, +1);
    }
  }
}

// ── Notification helpers ──────────────────────────────────────────

async function notifyAssignment(ctx: AgentContext, jobId: string): Promise<void> {
  const techNote = await runNotificationAgent(ctx, {
    jobId,
    channel: "technician_app",
    kind: "new_assignment",
  });
  ctx.bufferNotification(techNote);
  const custNote = await runNotificationAgent(ctx, {
    jobId,
    channel: "customer_email",
    kind: "booking_confirmed",
  });
  ctx.bufferNotification(custNote);
}

async function notifyReschedule(
  ctx: AgentContext,
  disruption: { options: ApprovalRequest["options"]; recommendedOptionId?: string },
  reason: string,
): Promise<void> {
  const opt =
    disruption.options.find((o) => o.recommended) ?? disruption.options[0];
  if (!opt) return;
  for (const move of opt.moves) {
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
}

export { notifyReschedule };

// ── small helpers ─────────────────────────────────────────────────

// Earliest we schedule an urgent job. Kept > freezeWindowHours so a
// bumpable soft job at the same slot is still "soft" (before its freeze
// point) when the incoming urgent job arrives. Mirrored in data/seed.ts.
export const URGENT_EARLIEST_HOURS = 4;

function clampSlot(tier: string, earliest: number, latest: number): number {
  // Pick a slot near the earliest end of the window, floored so it sits
  // outside the freeze window (keeps soft jobs re-plannable).
  const floor = tier === "urgent" ? URGENT_EARLIEST_HOURS : 5;
  return Math.min(Math.max(earliest, floor), Math.max(latest, floor));
}

function countLlm(ctx: AgentContext): number {
  return ctx.decisions.filter((d) => d.reasoning_kind === "llm").length;
}
