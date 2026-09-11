// ── Assignment / Scoring Agent ──────────────────────────────────────
// Rule-based transparent scoring. LLM is reserved for genuine edge cases
// only (the tie-break and edge-case agents, wired in the orchestrator).
//
// The scoring maths lives in `scoring.ts` so the tie-break / edge-case
// agents re-score candidates the exact same way. This module is the
// pipeline entry point: it reads the technician roster straight from
// AgentContext (loaded once, least-privilege by construction — the roster
// in memory never carries phone / home address; see `Technician` in
// types.ts), drops anyone who fails a HARD CONSTRAINT, scores the rest as
// a pool, and picks the top — or, for an urgent job with no free eligible
// technician, looks for a lower-tier job to bump.
//
// (There used to be a separate Technician-State Agent between
// Capacity and Assignment that re-shaped the roster into a "candidate"
// view before handing it here. It was folded into this agent: the fields
// it computed — within_working_hours, current_workload — were already
// being recomputed from scratch by the hard-constraint checks and the
// scoring engine below, so it was a pipeline stage whose output nothing
// downstream actually read. One fewer hop, same guarantees.)
//
// Hard constraints (a technician failing any of these is removed before
// scoring and never gets a number — CLAUDE.md §3.3):
//   1. skill match         — legal requirement, not a preference
//   2. working hours        — the appointment is inside the technician's shift
//   3. no double-booking    — no other job within ±90 min
//   4. route feasibility    — can actually reach the job from the previous
//                             stop on their route before it starts
// Rejected candidates are still returned so the feed shows *why*.

import { distanceKm } from "@/lib/geo";
import {
  findTimeClash,
  hoursBetween,
  isFrozen,
  isWithinWorkingHours,
  nowISO,
} from "@/lib/time";
import { logDecision } from "./log";
import { canReachInTime, scoreOneTech, scorePool } from "./scoring";
import type { AssignmentResult, IntakeResult } from "./schemas";
import type { CandidateScore, ScoreBreakdown, SkillTag, Tier } from "@/lib/types";
import type { AgentContext } from "./context";

// Re-export so existing importers (tie-break, edge-case agents) keep working.
export { scoreOneTech } from "./scoring";

export interface AssignmentInput {
  jobId: string;
  jobLocation: { lat: number; lng: number };
  skillRequired: SkillTag[];
  tier: Tier;
  urgencyHint: IntakeResult["urgency_hint"];
  scheduledTime: string;
  /** Booking creation time — feeds the SLA-headroom component. */
  jobCreatedAt?: string;
}

export function runAssignmentAgent(
  ctx: AgentContext,
  input: AssignmentInput,
): AssignmentResult {
  const common = {
    jobLocation: input.jobLocation,
    skillRequired: input.skillRequired,
    urgencyHint: input.urgencyHint,
    scheduledTime: input.scheduledTime,
    ignoreJobId: input.jobId,
    jobCreatedAt: input.jobCreatedAt,
    tier: input.tier,
  };

  const roster = ctx.technicians;

  // Score the eligible pool in one pass (min-max normalises travel +
  // availability across the survivors). Then walk the full roster to attach
  // a rejection reason to everyone who didn't make the pool, for the feed.
  const pool = scorePool(
    ctx,
    roster.map((t) => t.technician_id),
    common,
  );
  const breakdownById = new Map(pool.map((p) => [p.technician_id, p.breakdown]));

  const candidates: CandidateScore[] = roster.map((t) => {
    const bd = breakdownById.get(t.technician_id);
    if (bd) {
      return {
        technician_id: t.technician_id,
        technician_name: t.name,
        eligible: true,
        reject_reason: null,
        breakdown: bd,
      };
    }
    return reject(
      { technician_id: t.technician_id, name: t.name },
      rejectionReason(ctx, input, t.technician_id),
    );
  });

  const eligible = candidates
    .filter((c) => c.eligible && c.breakdown)
    .sort((a, b) => b.breakdown!.total - a.breakdown!.total);

  let assignedId: string | null = null;
  let assignedBreakdown: ScoreBreakdown | null = null;
  let conflict: AssignmentResult["conflict"] = null;

  if (eligible.length > 0) {
    assignedId = eligible[0].technician_id;
    assignedBreakdown = eligible[0].breakdown!;
  } else {
    const bump = tryFindBumpTarget(ctx, input);
    if (bump) {
      assignedId = bump.technician_id;
      assignedBreakdown = bump.breakdown;
      conflict = {
        bumped_job_id: bump.bumped_job_id,
        bumped_customer: bump.bumped_customer,
        technician_id: bump.technician_id,
      };
    }
  }

  const result: AssignmentResult = {
    assigned_technician_id: assignedId,
    score_breakdown: assignedBreakdown,
    candidates: candidates.map((c) => ({
      technician_id: c.technician_id,
      technician_name: c.technician_name,
      eligible: c.eligible,
      reject_reason: c.reject_reason,
      breakdown: c.breakdown,
    })),
    conflict,
    needs_llm_edgecase: eligible.length === 0 && !conflict,
  };

  const headline = assignedId
    ? conflict
      ? `Assign ${nameOf(ctx, assignedId)} — needs to move ${conflict.bumped_customer}'s job`
      : `Assigned ${nameOf(ctx, assignedId)} (match ${fmtScore(assignedBreakdown)})`
    : "No eligible technician — escalating for special handling";

  logDecision(ctx, {
    agent: "AssignmentAgent",
    jobId: input.jobId,
    reasoningKind: "rule",
    input: {
      skill_required: input.skillRequired,
      tier: input.tier,
      urgency: input.urgencyHint,
      policy: policySnapshot(ctx, input.tier),
      roster_size: roster.length,
    },
    output: {
      assigned_technician_id: assignedId,
      eligible_count: eligible.length,
      conflict: conflict ?? null,
      needs_llm_edgecase: result.needs_llm_edgecase,
    },
    headline,
    outcome: conflict ? "info" : assignedId ? "auto_commit" : "requires_approval",
    scoreBreakdown: assignedBreakdown,
    candidates,
    requiresApproval: !assignedId,
    guardrailNotes: [
      "Reads the technician roster from context — least-privilege by construction: location and workload only, never a technician's phone or home address.",
      "Four hard constraints filter the pool before scoring: certification, working hours, no double-booking, and route feasibility (can reach the job from the previous stop in time). Technicians that fail are removed, not penalised.",
      "Scoring: travel + skill-fit + availability + SLA-headroom + load-balance, each normalised to [0,1]; travel and availability are ranked within the candidate pool so they always separate candidates. Weights are the tier's dispatch policy and sum to 1, so the score is itself in [0,1].",
      result.needs_llm_edgecase
        ? "Cannot be resolved by the formula — will hand off to the LLM for edge-case handling."
        : "Resolved entirely by the formula — no LLM needed.",
    ],
  });

  return result;
}

// ── Rejection reasons (for the feed) ───────────────────────────────

function rejectionReason(
  ctx: AgentContext,
  input: AssignmentInput,
  technicianId: string,
): string {
  const t = ctx.getTechnician(technicianId);
  if (!t) return "Technician not found";
  if (!input.skillRequired.every((s) => t.skill_tags.includes(s))) {
    return `Missing certification: job needs ${input.skillRequired.join(", ")}`;
  }
  if (!isWithinWorkingHours(t.working_hours, input.scheduledTime)) {
    return "Outside working hours at the appointment time";
  }
  const clash = findTimeClash(ctx.jobs, technicianId, input.scheduledTime, input.jobId);
  if (clash) return `Schedule clash with job ${clash} (±90 min)`;
  if (
    !canReachInTime(ctx, technicianId, input.jobLocation, input.scheduledTime, input.jobId)
  ) {
    return "Cannot reach this job from the previous stop on their route in time";
  }
  return "Failed a hard constraint";
}

function reject(
  c: { technician_id: string; name: string },
  reason: string,
): CandidateScore {
  return {
    technician_id: c.technician_id,
    technician_name: c.name,
    eligible: false,
    reject_reason: reason,
    breakdown: null,
  };
}

// ── Urgent bump target search ──────────────────────────────────────

function tryFindBumpTarget(
  ctx: AgentContext,
  input: AssignmentInput,
): {
  technician_id: string;
  breakdown: ScoreBreakdown;
  bumped_job_id: string;
  bumped_customer: string;
} | null {
  if (input.tier !== "urgent") return null;
  const now = nowISO();

  // Every soft, not-yet-frozen job at this slot whose technician is
  // certified for the incoming job — each is a possible bump target.
  const candidates = ctx.jobs
    .filter(
      (j) =>
        j.assigned_technician_id &&
        (j.tier === "flexible" || j.tier === "standard") &&
        j.status === "assigned" &&
        !isFrozen(j.freeze_point, now) &&
        Math.abs(hoursBetween(j.scheduled_time, input.scheduledTime)) < 1.5,
    )
    .map((soft) => {
      const tech = ctx.getTechnician(soft.assigned_technician_id!);
      if (!tech || !input.skillRequired.every((s) => tech.skill_tags.includes(s))) {
        return null;
      }
      // Score this technician for the INCOMING job as if the soft job's
      // slot were about to free up — ignore both the incoming job and the
      // soft job so neither counts as a clash / route obstacle.
      const bd =
        scoreOneTech(ctx, {
          technicianId: tech.technician_id,
          jobLocation: input.jobLocation,
          skillRequired: input.skillRequired,
          urgencyHint: input.urgencyHint,
          scheduledTime: input.scheduledTime,
          ignoreJobId: soft.job_id,
          jobCreatedAt: input.jobCreatedAt,
          tier: input.tier,
        }) ??
        // The soft job's technician may still fail a constraint even with
        // the soft job removed (e.g. another job on their board). Fall back
        // to a zero breakdown so the bump can still be proposed — the
        // Disruption Agent re-validates everything anyway.
        ({
          travel: 0,
          skill_fit: 0,
          availability: 0,
          sla_headroom: 0,
          load_balance: 0,
          total: 0,
        } as ScoreBreakdown);
      return { soft, tech, breakdown: bd };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null)
    // Bump the LOWEST tier first; among equals, free up the technician who
    // scores BEST for the incoming job; then the job not yet rescheduled;
    // then the job physically CLOSEST to the incoming one (that
    // technician's route barely changes); then job_id. Every key is
    // deterministic so the same booking always bumps the same job.
    .sort(
      (a, b) =>
        tierRank(a.soft.tier) - tierRank(b.soft.tier) ||
        b.breakdown.total - a.breakdown.total ||
        a.soft.reschedule_history.length - b.soft.reschedule_history.length ||
        distanceKm(a.soft.location, input.jobLocation) -
          distanceKm(b.soft.location, input.jobLocation) ||
        a.soft.job_id.localeCompare(b.soft.job_id),
    );

  const best = candidates[0];
  if (!best) return null;
  return {
    technician_id: best.tech.technician_id,
    breakdown: best.breakdown,
    bumped_job_id: best.soft.job_id,
    bumped_customer: best.soft.customer_name,
  };
}

function tierRank(t: Tier): number {
  return { flexible: 0, standard: 1, priority: 2, urgent: 3 }[t];
}

// ── small helpers ─────────────────────────────────────────────────

function nameOf(ctx: AgentContext, id: string): string {
  return ctx.getTechnician(id)?.name ?? id;
}

function fmtScore(b: ScoreBreakdown | null): string {
  if (!b) return "—";
  return `${Math.round(b.total * 100)}%`;
}

function policySnapshot(ctx: AgentContext, tier: Tier) {
  return ctx.config.dispatchPolicy?.[tier] ?? undefined;
}
