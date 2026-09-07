// ── Assignment / Scoring Agent ──────────────────────────────────────
// Rule-based transparent scoring (CLAUDE.md §3.4). LLM is reserved for
// genuine edge cases only (flagged, not called in the MVP happy path).
//
//   score = w1*(1/distance_km) + w2*skill_match_bonus
//         + w3*urgency_weight  + w4*(1/current_workload)
//
// The skill match is a HARD CONSTRAINT: a technician without a matching
// skill_tag is dropped from candidacy entirely and never scored
// (CLAUDE.md §3.3 — legal requirement, not a preference). Rejected
// candidates are still returned so the feed shows *why*.

import { distanceKm } from "@/lib/geo";
import { findTimeClash, hoursBetween, isFrozen, nowISO } from "@/lib/time";
import { logDecision } from "./log";
import type { AssignmentResult, IntakeResult, TechStateResult } from "./schemas";
import type { CandidateScore, ScoreBreakdown, SkillTag, Tier } from "@/lib/types";
import type { AgentContext } from "./context";

const URGENCY_WEIGHT: Record<IntakeResult["urgency_hint"], number> = {
  low: 0.5,
  medium: 1.0,
  high: 2.0,
};

export interface AssignmentInput {
  jobId: string;
  jobLocation: { lat: number; lng: number };
  skillRequired: SkillTag[];
  tier: Tier;
  urgencyHint: IntakeResult["urgency_hint"];
  scheduledTime: string;
  techState: TechStateResult;
}

export function runAssignmentAgent(
  ctx: AgentContext,
  input: AssignmentInput,
): AssignmentResult {
  const cfg = ctx.config;
  const { w1, w2, w3, w4 } = cfg.scoreWeights;

  const candidates: CandidateScore[] = input.techState.candidates.map((c) => {
    // HARD CONSTRAINT 1: skill match.
    const hasSkill = input.skillRequired.every((s) =>
      c.skill_tags.includes(s),
    );
    if (!hasSkill) {
      return reject(c, `Missing certification: job needs ${input.skillRequired.join(", ")}`);
    }
    // HARD CONSTRAINT 2: working hours.
    if (!c.within_working_hours) {
      return reject(c, "Outside working hours at the appointment time");
    }
    // HARD CONSTRAINT 3: no double-booking within ±90 min.
    const clash = findTimeClash(ctx.jobs, c.technician_id, input.scheduledTime, input.jobId);
    if (clash) {
      return reject(c, `Schedule clash with job ${clash} (±90 min)`);
    }

    const dist = Math.max(distanceKm(c.location, input.jobLocation), 0.3);
    const workload = Math.max(c.current_workload, 0.5);
    const breakdown: ScoreBreakdown = {
      distance: round(w1 * (1 / dist)),
      skill_match: round(
        w2 * skillMatchBonus(input.skillRequired, c.skill_tags, c.experience_level),
      ),
      urgency: round(w3 * URGENCY_WEIGHT[input.urgencyHint]),
      workload: round(w4 * (1 / workload)),
      total: 0,
    };
    breakdown.total = round(
      breakdown.distance + breakdown.skill_match + breakdown.urgency + breakdown.workload,
    );
    return {
      technician_id: c.technician_id,
      technician_name: c.name,
      eligible: true,
      reject_reason: null,
      breakdown,
    };
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
      : `Assigned ${nameOf(ctx, assignedId)} (score ${assignedBreakdown?.total})`
    : "No eligible technician — escalating for special handling";

  logDecision(ctx, {
    agent: "AssignmentAgent",
    jobId: input.jobId,
    reasoningKind: "rule",
    input: {
      skill_required: input.skillRequired,
      tier: input.tier,
      urgency: input.urgencyHint,
      weights: cfg.scoreWeights,
      candidate_pool: input.techState.candidates.length,
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
      "Skill match is a hard constraint — technicians without the certification are removed before scoring.",
      result.needs_llm_edgecase
        ? "Cannot be resolved by the formula — will hand off to the LLM for edge-case handling."
        : "Resolved entirely by the formula — no LLM needed.",
    ],
  });

  return result;
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

function skillMatchBonus(
  required: string[],
  techSkills: readonly string[],
  level: "junior" | "senior",
): number {
  let bonus = 1.0;
  if (level === "senior") bonus += 0.5;
  const extra = techSkills.filter((s) => !required.includes(s)).length;
  if (extra === 0) bonus += 0.25;
  return bonus;
}

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
  const cfg = ctx.config;
  const { w1, w2, w3, w4 } = cfg.scoreWeights;
  const now = nowISO();

  const softJobs = ctx.jobs
    .filter(
      (j) =>
        j.assigned_technician_id &&
        (j.tier === "flexible" || j.tier === "standard") &&
        j.status === "assigned" &&
        !isFrozen(j.freeze_point, now) &&
        Math.abs(hoursBetween(j.scheduled_time, input.scheduledTime)) < 1.5,
    )
    .sort((a, b) => tierRank(a.tier) - tierRank(b.tier));

  for (const soft of softJobs) {
    const tech = ctx.getTechnician(soft.assigned_technician_id!);
    if (!tech) continue;
    const hasSkill = input.skillRequired.every((s) => tech.skill_tags.includes(s));
    if (!hasSkill) continue;

    const dist = Math.max(distanceKm(tech.location, input.jobLocation), 0.3);
    const workload = Math.max(tech.current_workload, 0.5);
    const breakdown: ScoreBreakdown = {
      distance: round(w1 * (1 / dist)),
      skill_match: round(
        w2 * skillMatchBonus(input.skillRequired, tech.skill_tags, tech.experience_level),
      ),
      urgency: round(w3 * URGENCY_WEIGHT[input.urgencyHint]),
      workload: round(w4 * (1 / workload)),
      total: 0,
    };
    breakdown.total = round(
      breakdown.distance + breakdown.skill_match + breakdown.urgency + breakdown.workload,
    );
    return {
      technician_id: tech.technician_id,
      breakdown,
      bumped_job_id: soft.job_id,
      bumped_customer: soft.customer_name,
    };
  }
  return null;
}

function tierRank(t: Tier): number {
  return { flexible: 0, standard: 1, priority: 2, urgent: 3 }[t];
}

function nameOf(ctx: AgentContext, id: string): string {
  return ctx.getTechnician(id)?.name ?? id;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
