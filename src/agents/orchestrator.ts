// ── Orchestrator ────────────────────────────────────────────────────
// The reasoning loop. Runs the pipeline from CLAUDE.md §4 for one
// booking, wiring typed outputs from each agent into the next, deciding
// auto-commit vs. HITL, and flushing all state + logs at the end.
//
//   Intake → Pricing → Capacity → Assignment
//     ├─ no conflict ─────────────→ commit + notify
//     └─ conflict ─→ Disruption ─→ auto-commit + notify
//                              └─→ HITL approval gate (stop here)
//
// Pricing runs AFTER intake (on the real required skills), not before —
// there is no provisional price pass on the dropdown hint.

import { AgentContext } from "./context";
import { logDecision } from "./log";
import { runPricingEngine } from "./pricing";
import { runJobIntakeAgent } from "./jobIntake";
import { runCapacityAgent } from "./capacity";
import { runAssignmentAgent } from "./assignment";
import {
  detectAmbiguity,
  loneCandidateIsStrained,
  runAssignmentTiebreakAgent,
} from "./assignmentTiebreak";
import { runDisruptionAgent } from "./disruption";
import {
  buildEdgecaseSpace,
  runAssignmentEdgecaseAgent,
} from "./assignmentEdgecase";
import { runNotificationAgent } from "./notification";
import {
  validateBookingRequest,
  type BookingRequest,
} from "./schemas";
import {
  addHours,
  computeFreezePoint,
  findTimeClash,
  isFrozen,
  nowISO,
  snapToStandardDispatchSlot,
  snapToUrgentDispatchSlot,
} from "@/lib/time";
import type { ApprovalRequest, Job } from "@/lib/types";

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

// ── Pipeline serialization ────────────────────────────────────────
// One AgentContext = one snapshot of the schedule loaded up front, mutated
// in memory, flushed at the end. Two pipeline runs overlapping in time
// would each load the schedule BEFORE the other committed, and could hand
// the same technician + slot to two different jobs (their staged
// assignments are invisible to each other). The deploy target is a single
// Lightsail Node process, so an in-process queue is enough: each booking
// runs start-to-flush before the next one begins. `POST /api/bookings`
// therefore processes concurrent submissions one at a time, in arrival
// order — a few seconds of extra latency under a burst, never a
// double-booking. (A multi-instance deploy would need a DB-level lock or
// an optimistic pre-flush re-check instead.)
let pipelineChain: Promise<unknown> = Promise.resolve();

export function runBookingPipeline(
  rawBooking: unknown,
): Promise<PipelineResult> {
  const run = pipelineChain.then(
    () => runBookingPipelineUnsafe(rawBooking),
    () => runBookingPipelineUnsafe(rawBooking),
  );
  // Keep the chain alive regardless of this run's outcome; swallow here so
  // a rejection doesn't become an unhandled rejection on the chain itself.
  pipelineChain = run.catch(() => undefined);
  return run;
}

// Monotonic suffixes so two entities created in the same millisecond can
// never collide on an id. This matters even though the pipeline is
// serialized: the id is generated before the previous run has necessarily
// advanced the wall clock, and under a mocked clock (robustness sweep) or
// a slow LLM provider (gateway) many runs share the exact same Date.now().
let jobIdSeq = 0;
let approvalIdSeq = 0;
function nextApprovalId(): string {
  return `apr_${Date.now().toString(36)}${(approvalIdSeq++).toString(36)}`;
}

async function runBookingPipelineUnsafe(
  rawBooking: unknown,
): Promise<PipelineResult> {
  const booking: BookingRequest = validateBookingRequest(rawBooking);
  const ctx = await AgentContext.create();
  const now = nowISO();
  const jobId = `job_${Date.now().toString(36)}${(jobIdSeq++).toString(36)}`;

  logDecision(ctx, {
    agent: "Orchestrator",
    jobId,
    reasoningKind: "rule",
    // customer_name is carried here (not just in the headline) so the live
    // Agent Flow Map can label a booking from its very first row, before
    // the full job record has flushed.
    input: {
      tier: booking.tier,
      category: booking.problem_category,
      customer_name: booking.customer_name,
    },
    output: { pipeline: "start" },
    headline: `New booking received (${booking.customer_name}, ${booking.tier})`,
    outcome: "info",
    guardrailNotes: ["Booking passed schema validation (least-privilege, oversize-guarded)."],
  });

  // Persist a skeleton job row right away (stageJob does a fire-and-forget
  // upsert on first stage). On the gateway the first "real" stageJob is
  // ~4s away, behind the Job-Intake LLM call — this lets the customer's
  // processing screen and /admin/flow find the booking in ~200ms instead
  // and start streaming pipeline progress. skill_required / price / the
  // snapped slot are filled in by the authoritative stageJob below; until
  // then the row carries safe placeholders.
  const skeletonNow = nowISO();
  ctx.stageJob({
    job_id: jobId,
    customer_name: booking.customer_name,
    customer_email: booking.customer_email,
    customer_phone: booking.customer_phone,
    location: { ...booking.location, address: booking.address },
    problem_description: booking.problem_description,
    problem_category: booking.problem_category,
    photo_url: booking.photo_url,
    skill_required: [],
    tier: booking.tier,
    scheduled_time: skeletonNow,
    freeze_point: skeletonNow,
    status: "pending",
    assigned_technician_id: null,
    score_breakdown: null,
    price: 0,
    created_at: now,
    pipeline_stage: "intake",
    reschedule_history: [],
  });

  // ── 1. Job-Intake (LLM) ─────────────────────────────────────────
  const intake = await runJobIntakeAgent(ctx, jobId, booking);

  // ── 2. Pricing (rule) ───────────────────────────────────────────
  // Priced once, after intake, on the real required skills — no
  // provisional pass on the dropdown hint (it never reached the customer
  // and only added noise to the activity feed).
  const pricing = runPricingEngine(ctx, {
    jobId,
    skillRequired: intake.skill_required,
    tier: booking.tier,
  });

  // ── 3. Capacity (rule) ──────────────────────────────────────────
  // Earliest-possible slot is tier-only — the customer selected and paid
  // for this tier, so it alone sets scheduling urgency. (This used to also
  // take an `earliest`/`latest` window the Job-Intake LLM inferred from the
  // free-text description, which let a blank or mild-sounding description
  // silently override an Urgent booking's own SLA — e.g. proposing a slot
  // 24h out for a job the customer paid 1.75x to have handled same-day.)
  let slotHours = tierEarliestHours(booking.tier);
  const capacity = runCapacityAgent(ctx, {
    jobId,
    tier: booking.tier,
    proposedSlotHours: slotHours,
    skillRequired: intake.skill_required,
  });

  if (capacity.decision === "suggest_alternative_slot" && capacity.alternative_slot_hours) {
    slotHours = capacity.alternative_slot_hours;
  }

  // Snap to a slot inside service hours so scoring isn't handed an
  // appointment every technician would reject as off-hours. Both tiers use
  // the same wide 08:00–20:00 window (the real hard limit is each
  // technician's own working_hours, checked downstream) with a same-day
  // rollover guard so the slot never drifts onto a different calendar day
  // than a same-instant urgent/seeded job depending on wall-clock time.
  // Urgent gets a later same-day cutoff (more headroom for a same-day
  // re-plan if it needs to bump something); non-urgent tiers roll over
  // earlier since they have days/weeks of slack anyway.
  const scheduledTime =
    booking.tier === "urgent"
      ? snapToUrgentDispatchSlot(now, slotHours)
      : snapToStandardDispatchSlot(now, slotHours);
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

  // ── 4. Assignment / Scoring (rule) ──────────────────────────────
  // Reads the technician roster straight from AgentContext (loaded once,
  // least-privilege by construction) — see assignment.ts's header note on
  // why there is no separate Technician-State stage anymore.
  const assignment = runAssignmentAgent(ctx, {
    jobId,
    jobLocation: booking.location,
    skillRequired: intake.skill_required,
    tier: booking.tier,
    scheduledTime,
    jobCreatedAt: now,
  });

  const decisionLogIds = () => ctx.decisions.map((d) => d.log_id);

  // ── 4·½. Assignment tie-break (LLM, ambiguity-only) ────────────
  // The formula gives a clean, deterministic ranking. But when the top
  // pick is effectively a coin-flip, or the only eligible technician is
  // strained, a coordinator would weigh things the formula does not — so
  // we ask the LLM. It picks within the eligible top-3 and its choice is
  // re-scored against live state; otherwise the formula's pick stands.
  // This never runs on an unambiguous ranking (the common case).
  if (assignment.assigned_technician_id && !assignment.conflict) {
    const eligible = assignment.candidates
      .filter((c) => c.eligible && c.breakdown)
      .sort((a, b) => b.breakdown!.total - a.breakdown!.total);

    let trigger = detectAmbiguity(assignment.candidates, { tier: booking.tier });
    if (!trigger && eligible.length === 1) {
      trigger = loneCandidateIsStrained(
        ctx,
        eligible[0].technician_id,
        booking.location,
        scheduledTime,
        jobId,
      );
    }

    if (trigger) {
      const tb = await runAssignmentTiebreakAgent(ctx, {
        input: {
          jobId,
          jobLocation: booking.location,
          address: booking.address,
          skillRequired: intake.skill_required,
          tier: booking.tier,
          scheduledTime,
          jobCreatedAt: now,
        },
        trigger,
        formulaTopId: assignment.assigned_technician_id,
        shortlistIds: eligible.slice(0, 3).map((c) => c.technician_id),
      });
      // Adopt the tie-breaker's (re-validated) choice for every downstream
      // branch. If it kept the formula's pick this is a no-op.
      assignment.assigned_technician_id = tb.technicianId;
      assignment.score_breakdown = tb.scoreBreakdown;
    }
  }

  // 4a. No technician from the formula — try the LLM edge-case levers
  // before giving up, then escalate if nothing safe fits.
  if (!assignment.assigned_technician_id) {
    if (assignment.needs_llm_edgecase) {
      const edgeInput = {
        jobId,
        jobLocation: booking.location,
        skillRequired: intake.skill_required,
        scheduledTime,
        tier: booking.tier,
        jobCreatedAt: now,
      };
      const space = buildEdgecaseSpace(ctx, edgeInput);
      const edge = await runAssignmentEdgecaseAgent(ctx, { input: edgeInput, space });

      // Lever 1: widen_window → commit like a clean assignment, new slot.
      if (edge.action === "widen_window" && edge.resolvedAssignment) {
        const newTime = edge.resolvedAssignment.scheduled_time;
        const newFreeze = computeFreezePoint(newTime, ctx.config.freezeWindowHours);
        job = {
          ...job,
          scheduled_time: newTime,
          freeze_point: newFreeze,
          status: isFrozen(newFreeze, now) ? "frozen" : "assigned",
          assigned_technician_id: edge.resolvedAssignment.technician_id,
          score_breakdown: edge.resolvedAssignment.score_breakdown,
          pipeline_stage: "assigned",
        };
        ctx.stageJob(job);
        ctx.stageWorkload(edge.resolvedAssignment.technician_id, +1);
        await notifyAssignment(ctx, jobId);
        logDecision(ctx, {
          agent: "Orchestrator",
          jobId,
          reasoningKind: "rule",
          input: { eligible: 0, edgecase_action: "widen_window" },
          output: { result: "assigned_auto", technician: edge.resolvedAssignment.technician_id },
          headline: "Auto-commit: assigned via edge-case (widened time window)",
          outcome: "auto_commit",
          guardrailNotes: [
            "Formula found no slot, but a certified technician was free nearby — the LLM's pick was re-scored against live state before commit.",
          ],
        });
        await ctx.flush();
        return {
          job,
          status: "assigned_auto",
          decisionLogIds: decisionLogIds(),
          notificationsSent: ctx.notifications.length,
          llmCalls: countLlm(ctx),
          message: `Assigned ${ctx.getTechnician(edge.resolvedAssignment.technician_id)?.name} at ${newTime} — ${edge.rationale}`,
        };
      }

      // Levers 2/3: split_visit or pair — a proposal for the coordinator.
      if (
        (edge.action === "split_visit" || edge.action === "pair_junior_senior") &&
        edge.proposalForHuman
      ) {
        const approval: ApprovalRequest = {
          approval_id: nextApprovalId(),
          created_at: nowISO(),
          kind: "standard",
          job_id: jobId,
          reason: `The scoring formula found no single technician. The edge-case agent proposes: ${edge.proposalForHuman}`,
          disruption_log_id: edge.logId,
          options: [],
          chosen_option_id: null,
          status: "pending",
          resolved_by: null,
          resolved_at: null,
          frozen_jobs_impacted: [],
        };
        ctx.bufferApproval(approval);
        job = { ...job, status: "pending", pipeline_stage: "awaiting_approval" };
        ctx.stageJob(job);
        logDecision(ctx, {
          agent: "Orchestrator",
          jobId,
          reasoningKind: "rule",
          input: { eligible: 0, edgecase_action: edge.action },
          output: { result: "awaiting_approval", approval_id: approval.approval_id },
          headline: "Paused — edge-case proposal needs coordinator approval",
          outcome: "requires_approval",
          requiresApproval: true,
          guardrailNotes: [
            "The agent proposes a non-standard dispatch (split visit / supervised pair); a human decides whether to run it.",
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
          message: `Edge-case proposal awaiting coordinator approval: ${edge.rationale}`,
        };
      }

      // Lever 4 (or fallthrough): escalate — carry the agent's reasoning.
      job = { ...job, status: "pending", pipeline_stage: "awaiting_approval" };
      ctx.stageJob(job);
      logDecision(ctx, {
        agent: "Orchestrator",
        jobId,
        reasoningKind: "rule",
        input: { eligible: 0, edgecase_action: "escalate" },
        output: { result: "unassignable" },
        headline: "No technician found — escalated to the coordinator",
        outcome: "requires_approval",
        requiresApproval: true,
        guardrailNotes: [
          "Stops at the right point: never forces a job onto an uncertified technician.",
          "The edge-case agent checked every lever first and found none safe.",
        ],
      });
      await ctx.flush();
      return {
        job,
        status: "unassignable",
        decisionLogIds: decisionLogIds(),
        notificationsSent: 0,
        llmCalls: countLlm(ctx),
        message: edge.rationale,
      };
    }

    // needs_llm_edgecase is false (a conflict path handled elsewhere, or a
    // structural no-op) — plain escalation.
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

  // 4b. Clean assignment, no conflict → auto-commit.
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

  // 4c. Conflict → Disruption Agent.
  // Stage the incoming job onto its intended technician + slot FIRST, so
  // every clash check inside the Disruption Agent (candidate-space
  // generation and plan re-validation) treats it as a real obstacle. Without
  // this the bumped job can be re-planned into a slot that still collides
  // with the incoming job, because the incoming job was still unassigned in
  // the schedule the agent reasoned over.
  job = {
    ...job,
    status: "assigned",
    assigned_technician_id: assignment.assigned_technician_id,
    score_breakdown: assignment.score_breakdown,
    pipeline_stage: "disruption_review",
  };
  ctx.stageJob(job);

  const disruption = await runDisruptionAgent(ctx, {
    incomingJobId: jobId,
    assignment,
  });

  // 4c-i. Freeze window is absolute: if every mechanical option would
  // touch a frozen job, no re-plan is proposed at all. Report unassignable
  // so the customer/coordinator can pick a different time instead of the
  // pipeline ever offering to break a locked appointment.
  if (disruption.noCleanOption) {
    job = { ...job, status: "pending", pipeline_stage: "awaiting_approval" };
    ctx.stageJob(job);
    logDecision(ctx, {
      agent: "Orchestrator",
      jobId,
      reasoningKind: "rule",
      input: { conflict: true, no_clean_option: true },
      output: { result: "unassignable_frozen" },
      headline: "No technician available today — every option would touch a locked appointment",
      outcome: "requires_approval",
      requiresApproval: true,
      guardrailNotes: [
        "Freeze window treated as absolute — the pipeline never proposes touching a frozen job, even under an urgent request.",
      ],
    });
    await ctx.flush();
    return {
      job,
      status: "unassignable",
      decisionLogIds: decisionLogIds(),
      notificationsSent: 0,
      llmCalls: countLlm(ctx),
      message:
        "No technician available for this time slot — every nearby slot would move a locked appointment. Please choose a different time.",
    };
  }

  if (!disruption.needsApproval && disruption.autoChosenOptionId) {
    // Low impact → auto-commit the recommended re-plan.
    applyReplan(
      ctx,
      disruption.autoChosenOptionId,
      disruption.options,
      "auto",
      "Urgent job took priority",
    );

    // Last-line integrity check before auto-committing — if the re-plan
    // somehow leaves the incoming job clashing, escalate to a human
    // instead of double-booking.
    const clash = incomingJobClashAfterReplan(ctx, jobId);
    if (clash) {
      job = { ...job, status: "pending", pipeline_stage: "awaiting_approval" };
      ctx.stageJob(job);
      logDecision(ctx, {
        agent: "Orchestrator",
        jobId,
        reasoningKind: "rule",
        input: { conflict: true, approval: false, auto_commit_blocked: true },
        output: { result: "unassignable", clashing_job: clash },
        headline: `Auto-commit blocked — the re-plan would still double-book the technician (job ${clash})`,
        outcome: "requires_approval",
        requiresApproval: true,
        guardrailNotes: [
          "Post-apply safety check failed — the pipeline refused to auto-commit a double-booking and handed the job to a coordinator.",
        ],
      });
      await ctx.flush();
      return {
        job,
        status: "unassignable",
        decisionLogIds: decisionLogIds(),
        notificationsSent: 0,
        llmCalls: countLlm(ctx),
        message:
          "The automatic re-plan could not place this job cleanly. Escalated to the coordinator.",
      };
    }

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

  // 4d. High impact → HITL approval gate. STOP here.
  // (Freeze window can never be the reason we land here — that case
  // already returned above as "unassignable".)
  const approval: ApprovalRequest = {
    approval_id: nextApprovalId(),
    created_at: nowISO(),
    kind: "standard",
    job_id: jobId,
    reason: "The re-plan exceeds the allowed impact threshold (customers affected / added travel / SLA breach).",
    disruption_log_id: disruption.logId,
    options: disruption.options,
    chosen_option_id: null,
    status: "pending",
    resolved_by: null,
    resolved_at: null,
    frozen_jobs_impacted: [],
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
    input: { conflict: true, approval: true },
    output: { result: "awaiting_approval", approval_id: approval.approval_id },
    headline: "Paused — coordinator must approve the re-plan",
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
    message: "The re-plan needs coordinator approval. Awaiting.",
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

/**
 * Last-line integrity check before an incoming job is committed onto its
 * technician: after the re-plan moves have been applied, the incoming job's
 * slot must be clear of every other job on that technician (±90 min). The
 * Disruption Agent's space generation and re-validation already enforce
 * this, but this is cheap defence-in-depth against a state drift or a bad
 * option reaching commit. Returns the clashing job id, or null if clean.
 */
export function incomingJobClashAfterReplan(
  ctx: AgentContext,
  incomingJobId: string,
): string | null {
  const job = ctx.getJob(incomingJobId);
  if (!job || !job.assigned_technician_id) return null;
  return findTimeClash(
    ctx.jobs,
    job.assigned_technician_id,
    job.scheduled_time,
    incomingJobId,
  );
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
  disruption: { options: ApprovalRequest["options"]; recommendedOptionId?: string | null },
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
// (Still 4h for now — lowering this floor further is tracked separately
// and intentionally not part of this change.)
export const URGENT_EARLIEST_HOURS = 4;
const NON_URGENT_EARLIEST_HOURS = 5;

/**
 * The earliest-possible slot, in hours from now, for a given tier. This is
 * the ONLY input to scheduling urgency — the customer's tier selection,
 * nothing an AI agent infers from the free-text description. Job-Intake no
 * longer proposes a window here (see schemas.ts / jobIntake.ts).
 */
function tierEarliestHours(tier: string): number {
  return tier === "urgent" ? URGENT_EARLIEST_HOURS : NON_URGENT_EARLIEST_HOURS;
}

function countLlm(ctx: AgentContext): number {
  return ctx.decisions.filter((d) => d.reasoning_kind === "llm").length;
}
