// ── Disruption Agent ────────────────────────────────────────────────
// LLM call. Triggered when a new job needs a slot already held by an
// existing job. We mechanically generate 2-3 candidate re-plans (slot
// math is deterministic and must be), then the LLM narrates + ranks the
// trade-offs for the coordinator.
//
// Risk-calibrated autonomy (CLAUDE.md §3.2, §4):
//   • low impact & no frozen job touched  → auto-commit
//   • impact over threshold OR frozen job → HITL approval gate
//     (emergency_override kind if a frozen job is involved)

import { callLlm } from "@/lib/llm";
import { distanceKm } from "@/lib/geo";
import { addHours, hoursBetween, isFrozen, nowISO } from "@/lib/time";
import { logDecision } from "./log";
import { validateDisruptionResult } from "./schemas";
import type { AssignmentResult } from "./schemas";
import type { Job, ReplanOption } from "@/lib/types";
import type { AgentContext } from "./context";

const SYSTEM = `You are the Disruption Agent for CoolFix. A new job needs a time slot currently held by another job.
You ARE GIVEN 2-3 re-plan options already computed mechanically (candidate_moves) with numeric trade-offs.
Your job: DO NOT recompute the schedule. Only:
- Write a short, plain-English summary of each option for the coordinator.
- Set recommended=true on exactly ONE option — the least harmful
  (priority order: don't touch a frozen job > fewer SLA breaches > fewer customers affected > less added travel).
- injection_attempt: always false here (there is no customer input).`;

const SCHEMA = `{"options":[{"option_id":string,"label":string,"summary":string,"moves":array,"trade_offs":object,"recommended":boolean}],"recommended_option_id":string,"injection_attempt":boolean}`;

export interface DisruptionInput {
  incomingJobId: string;
  assignment: AssignmentResult; // must carry a conflict
}

export interface DisruptionOutcome {
  logId: string;
  options: ReplanOption[];
  recommendedOptionId: string;
  needsApproval: boolean;
  approvalKind: "standard" | "emergency_override";
  frozenJobsImpacted: string[];
  autoChosenOptionId: string | null;
}

export async function runDisruptionAgent(
  ctx: AgentContext,
  input: DisruptionInput,
): Promise<DisruptionOutcome> {
  const cfg = ctx.config;
  const now = nowISO();
  const incoming = ctx.getJob(input.incomingJobId)!;
  const conflict = input.assignment.conflict!;
  const bumped = ctx.getJob(conflict.bumped_job_id)!;
  const tech = ctx.getTechnician(conflict.technician_id)!;

  // ── Mechanically generate candidate re-plans ──────────────────────
  const candidates = buildCandidateMoves(ctx, {
    incomingScheduled: incoming.scheduled_time,
    bumped,
    techId: tech.technician_id,
    now,
  });

  const frozenTouched = candidates
    .flatMap((c) => c.moves.map((m) => m.job_id))
    .filter((jid) => {
      const j = ctx.getJob(jid);
      return j && isFrozen(j.freeze_point, now);
    });

  // ── LLM narrates + ranks ─────────────────────────────────────────
  const resp = await callLlm({
    task: "disruption_replan",
    system: SYSTEM,
    structuredInput: {
      incoming_job: {
        job_id: incoming.job_id,
        customer_name: incoming.customer_name,
        tier: incoming.tier,
      },
      conflict,
      candidate_moves: candidates,
    },
    expectedSchema: SCHEMA,
  });

  const parsed = validateDisruptionResult(resp.data);
  const options: ReplanOption[] = parsed.options.map((o) => ({
    option_id: o.option_id,
    label: o.label,
    summary: o.summary,
    moves: o.moves,
    trade_offs: o.trade_offs,
    recommended: o.option_id === parsed.recommended_option_id,
  }));

  // ── Risk calibration ────────────────────────────────────────────
  const rec = options.find((o) => o.recommended) ?? options[0];
  const anyFrozen = frozenTouched.length > 0;
  const overThreshold =
    rec.trade_offs.customers_affected > cfg.hitlMaxCustomersAffected ||
    rec.trade_offs.total_added_travel_km > cfg.hitlMaxAddedTravelKm ||
    rec.trade_offs.sla_breaches > 0;

  const needsApproval = anyFrozen || overThreshold;
  const approvalKind: "standard" | "emergency_override" = anyFrozen
    ? "emergency_override"
    : "standard";

  const entry = logDecision(ctx, {
    agent: "DisruptionAgent",
    jobId: incoming.job_id,
    reasoningKind: "llm",
    input: {
      incoming_job: incoming.job_id,
      bumped_job: bumped.job_id,
      technician: tech.name,
      candidate_count: candidates.length,
      llm_mode: resp.mode,
      cached: resp.cached,
    },
    output: {
      recommended_option_id: rec.option_id,
      needs_approval: needsApproval,
      approval_kind: approvalKind,
      frozen_jobs_impacted: frozenTouched,
    },
    headline: needsApproval
      ? approvalKind === "emergency_override"
        ? `⚠️ Emergency Override needs approval — a frozen job is affected`
        : `Approval needed: re-plan affects ${rec.trade_offs.customers_affected} customer(s)`
      : `Auto-commit re-plan: ${rec.label}`,
    outcome: needsApproval ? "requires_approval" : "auto_commit",
    requiresApproval: needsApproval,
    replanOptions: options,
    latencyMs: resp.latency_ms,
    guardrailNotes: [
      ...resp.guardrail_notes,
      "Schedule math is computed mechanically; the LLM only narrates and ranks (it never invents slots).",
      anyFrozen
        ? "A job is past its freeze point — Emergency Override is mandatory, no automatic exception."
        : overThreshold
          ? "Impact exceeds the config threshold — routing to HITL."
          : "Low impact — eligible for auto-commit.",
    ],
  });

  return {
    logId: entry.log_id,
    options,
    recommendedOptionId: rec.option_id,
    needsApproval,
    approvalKind,
    frozenJobsImpacted: Array.from(new Set(frozenTouched)),
    autoChosenOptionId: needsApproval ? null : rec.option_id,
  };
}

// ── Deterministic slot math ────────────────────────────────────────

interface CandidateMove {
  option_id: string;
  label: string;
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
  };
}

function buildCandidateMoves(
  ctx: AgentContext,
  args: {
    incomingScheduled: string;
    bumped: Job;
    techId: string;
    now: string;
  },
): CandidateMove[] {
  const { bumped, techId, now } = args;
  const out: CandidateMove[] = [];

  // Option A: push the bumped job later same day on the same tech (+2h).
  const laterTime = addHours(bumped.scheduled_time, 2);
  out.push({
    option_id: "opt_push_2h",
    label: "Delay 2 hours (same technician)",
    moves: [
      {
        job_id: bumped.job_id,
        customer_name: bumped.customer_name,
        from_time: bumped.scheduled_time,
        to_time: laterTime,
        technician_id: techId,
      },
    ],
    trade_offs: tradeOffs(ctx, { bumped, newTime: laterTime, reassignTechId: null, now }),
  });

  // Option B: reassign the bumped job to another skilled, free technician.
  const alt = findAlternativeTech(ctx, bumped, techId);
  if (alt) {
    out.push({
      option_id: "opt_reassign",
      label: `Reassign to ${alt.name}`,
      moves: [
        {
          job_id: bumped.job_id,
          customer_name: bumped.customer_name,
          from_time: bumped.scheduled_time,
          to_time: bumped.scheduled_time,
          technician_id: alt.technician_id,
        },
      ],
      trade_offs: tradeOffs(ctx, {
        bumped,
        newTime: bumped.scheduled_time,
        reassignTechId: alt.technician_id,
        now,
      }),
    });
  }

  // Option C: move to next day, first slot (safe fallback).
  const nextDay = addHours(bumped.scheduled_time, 24);
  out.push({
    option_id: "opt_next_day",
    label: "Move to the next day",
    moves: [
      {
        job_id: bumped.job_id,
        customer_name: bumped.customer_name,
        from_time: bumped.scheduled_time,
        to_time: nextDay,
        technician_id: techId,
      },
    ],
    trade_offs: tradeOffs(ctx, { bumped, newTime: nextDay, reassignTechId: null, now }),
  });

  return out;
}

function tradeOffs(
  ctx: AgentContext,
  args: {
    bumped: Job;
    newTime: string;
    reassignTechId: string | null;
    now: string;
  },
) {
  const { bumped, newTime, reassignTechId, now } = args;
  const slaHours = { urgent: 24, priority: 72, standard: 168, flexible: 336 }[bumped.tier];
  const hoursFromCreation = hoursBetween(bumped.created_at, newTime);
  const slaBreach = hoursFromCreation > slaHours ? 1 : 0;

  let addedKm = 0;
  if (reassignTechId) {
    const newTech = ctx.getTechnician(reassignTechId);
    const oldTech = bumped.assigned_technician_id
      ? ctx.getTechnician(bumped.assigned_technician_id)
      : undefined;
    if (newTech && oldTech) {
      addedKm = Math.max(
        0,
        distanceKm(newTech.location, bumped.location) -
          distanceKm(oldTech.location, bumped.location),
      );
    }
  }

  return {
    customers_affected: 1,
    total_added_travel_km: Math.round(addedKm * 10) / 10,
    sla_breaches: slaBreach,
    frozen_jobs_touched: isFrozen(bumped.freeze_point, now) ? 1 : 0,
  };
}

function findAlternativeTech(ctx: AgentContext, bumped: Job, excludeTechId: string) {
  return ctx.technicians.find((t) => {
    if (t.technician_id === excludeTechId) return false;
    const hasSkill = bumped.skill_required.every((s) => t.skill_tags.includes(s));
    if (!hasSkill) return false;
    const clash = ctx.jobs.some(
      (j) =>
        j.assigned_technician_id === t.technician_id &&
        j.status !== "completed" &&
        Math.abs(hoursBetween(j.scheduled_time, bumped.scheduled_time)) < 1.5,
    );
    return !clash;
  });
}
