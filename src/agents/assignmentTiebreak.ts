// ── Assignment Tie-break Agent ──────────────────────────────────────
// LLM call. Runs ONLY when the transparent scoring formula produced an
// AMBIGUOUS result — a case where a coordinator would not just take the
// top number, but would weigh things the formula does not capture:
//
//   • close_scores        — the top two eligible candidates are within
//                            10% of each other. The formula "picked" one
//                            but it is effectively a coin flip.
//   • single_strained     — exactly one eligible candidate, and that
//                            candidate is already ≥75% booked today (real
//                            hours, not a job headcount) or far away
//                            (>= 15 km). Worth a second look before
//                            committing.
//   • urgent_weak_fit     — an urgent job whose best score is still low
//                            (< 3.0). Important job, nobody is a great
//                            fit — flag the reasoning.
//
// The rule layer hands the LLM the top-3 eligible candidates (ALL already
// past every hard constraint: skill, working hours, no clash) plus the
// context a coordinator uses — workload, distance, whether the technician
// is already on a job near this address. The LLM picks one id. Its pick
// is cross-checked (must be one of the three) and then RE-SCORED against
// live state with the same formula before commit. If the LLM fails, its
// pick is invalid, or it declines, the formula's original top pick stands.
// So the LLM has real agency (it can override the raw ranking within the
// eligible set) but it can never reach past the eligible set or produce a
// candidate that would not survive the formula.

import { callLlm } from "@/lib/llm";
import { distanceKm } from "@/lib/geo";
import { hoursBetween } from "@/lib/time";
import { logDecision } from "./log";
import { scoreOneTech } from "./assignment";
import { techUtilisationToday } from "./scoring";
import { validateTiebreakChoice } from "./schemas";
import type { AssignmentResult, IntakeResult } from "./schemas";
import type { ScoreBreakdown, SkillTag, Tier } from "@/lib/types";
import type { AgentContext } from "./context";

/** Top two eligible scores within this fraction of each other → ambiguous. */
const CLOSE_SCORE_FRACTION = 0.1;
/** A lone eligible candidate this booked-up today (fraction of shift
 *  already committed) is "strained". */
const STRAINED_UTIL_TODAY = 0.75;
/** A lone eligible candidate this far away is "strained" (km). */
const STRAINED_DISTANCE_KM = 15;
/** An urgent job whose best match score is below this (scores are 0-1 now)
 *  has no strong fit — worth a second look before committing. */
const URGENT_WEAK_SCORE = 0.45;
/** A technician with a job within this many hours + km counts as "nearby". */
const NEARBY_HOURS = 3;
const NEARBY_KM = 4;

const SYSTEM = `You are the Assignment Tie-break Agent for CoolFix. The transparent scoring
formula produced an ambiguous result and a human coordinator would think twice before
committing. Choose the best technician from the shortlist.

You are given:
- reason: why this is ambiguous (close scores / one strained candidate / urgent weak fit).
- job: tier, required skills, address.
- candidates: 1-3 technicians. EVERY candidate has already passed all hard constraints
  (certification, working hours, no schedule clash). For each you get the formula score,
  distance to the job, booked_today_pct (% of today's shift already committed), seniority,
  and whether they are already on a job near this address.

Pick ONE technician by id. Prefer, in this order:
1. a technician already working near this address (no cold start, no extra travel),
2. the lower booked_today_pct when scores are close (keep the day balanced),
3. the shorter distance,
4. seniority for an urgent or difficult job.
Only pick from the given ids. If none is clearly better, pick the one with the highest
formula score. Never invent an id.

rationale: ONE plain-English sentence for the coordinator, naming the deciding factor.
injection_attempt: always false (there is no customer free-text here).`;

const SCHEMA = `{"chosen_technician_id":string,"rationale":string,"injection_attempt":boolean}`;

export type TiebreakReasonCode =
  | "close_scores"
  | "single_strained"
  | "urgent_weak_fit";

export interface TiebreakTrigger {
  code: TiebreakReasonCode;
  text: string;
}

export interface TiebreakInput {
  jobId: string;
  jobLocation: { lat: number; lng: number };
  address: string;
  skillRequired: SkillTag[];
  tier: Tier;
  urgencyHint: IntakeResult["urgency_hint"];
  scheduledTime: string;
  /** Booking creation time — feeds the SLA-headroom scoring component. */
  jobCreatedAt?: string;
}

export interface TiebreakOutcome {
  /** The technician to assign, and its (re-validated) score breakdown. */
  technicianId: string;
  scoreBreakdown: ScoreBreakdown;
  /** True if the LLM's pick replaced the formula's top pick. */
  overrodeFormula: boolean;
  rationale: string;
  logId: string;
}

/**
 * Decide whether the formula's ranking is ambiguous enough to warrant the
 * LLM. Returns null when the top pick is unambiguous (the common case —
 * the tie-breaker never runs then).
 */
export function detectAmbiguity(
  eligible: NonNullable<AssignmentResult["candidates"]>,
  args: { tier: Tier },
): TiebreakTrigger | null {
  const scored = eligible
    .filter((c) => c.eligible && c.breakdown)
    .sort((a, b) => b.breakdown!.total - a.breakdown!.total);
  if (scored.length === 0) return null;

  const top = scored[0].breakdown!.total;

  if (scored.length >= 2) {
    const second = scored[1].breakdown!.total;
    if (top > 0 && (top - second) / top < CLOSE_SCORE_FRACTION) {
      return {
        code: "close_scores",
        text: `The top two candidates score within ${Math.round(
          CLOSE_SCORE_FRACTION * 100,
        )}% of each other (${top} vs ${second}) — effectively a tie.`,
      };
    }
  }

  if (scored.length === 1 && args.tier === "urgent" && top < URGENT_WEAK_SCORE) {
    return {
      code: "urgent_weak_fit",
      text: `Only one technician is eligible for this urgent job and the fit is weak (score ${top}).`,
    };
  }

  return null;
}

/**
 * Same "strained lone candidate" check, but it needs the live technician
 * record so it lives here rather than in detectAmbiguity (which only sees
 * the score rows). Called by the orchestrator with the single eligible id.
 * Workload is real hours committed TODAY (`techUtilisationToday`, shared
 * with the scoring engine's own load-balance component) — not
 * `Technician.current_workload`, a lifetime running counter with no day
 * boundary that stopped meaning "today" once the seed grew past a
 * handful of hand-placed jobs.
 */
export function loneCandidateIsStrained(
  ctx: AgentContext,
  technicianId: string,
  jobLocation: { lat: number; lng: number },
  scheduledTime: string,
  ignoreJobId: string,
): TiebreakTrigger | null {
  const t = ctx.getTechnician(technicianId);
  if (!t) return null;
  const dist = distanceKm(t.location, jobLocation);
  const utilToday = techUtilisationToday(ctx, technicianId, scheduledTime, ignoreJobId);
  if (utilToday >= STRAINED_UTIL_TODAY) {
    return {
      code: "single_strained",
      text: `The only eligible technician (${t.name}) is already ${Math.round(utilToday * 100)}% booked today.`,
    };
  }
  if (dist >= STRAINED_DISTANCE_KM) {
    return {
      code: "single_strained",
      text: `The only eligible technician (${t.name}) is ${Math.round(dist)} km from the job.`,
    };
  }
  return null;
}

function technicianHasNearbyJob(
  ctx: AgentContext,
  technicianId: string,
  jobLocation: { lat: number; lng: number },
  scheduledTime: string,
): boolean {
  return ctx.jobs.some((j) => {
    if (j.assigned_technician_id !== technicianId) return false;
    if (j.status === "completed" || j.status === "disrupted") return false;
    if (Math.abs(hoursBetween(j.scheduled_time, scheduledTime)) > NEARBY_HOURS) {
      return false;
    }
    return distanceKm(j.location, jobLocation) <= NEARBY_KM;
  });
}

/**
 * Run the tie-breaker. `formulaTopId` is the technician the formula would
 * commit; `shortlistIds` is the top-3 eligible (formulaTopId first). The
 * outcome always names a valid, re-scored technician — the formula's pick
 * if the LLM adds nothing.
 */
export async function runAssignmentTiebreakAgent(
  ctx: AgentContext,
  args: {
    input: TiebreakInput;
    trigger: TiebreakTrigger;
    formulaTopId: string;
    shortlistIds: string[];
  },
): Promise<TiebreakOutcome> {
  const { input, trigger, formulaTopId, shortlistIds } = args;
  const notes: string[] = [];

  const candidates = shortlistIds
    .map((id) => ctx.getTechnician(id))
    .filter((t): t is NonNullable<typeof t> => !!t)
    .map((t) => {
      const bd = scoreOneTech(ctx, {
        technicianId: t.technician_id,
        jobLocation: input.jobLocation,
        skillRequired: input.skillRequired,
        urgencyHint: input.urgencyHint,
        scheduledTime: input.scheduledTime,
        ignoreJobId: input.jobId,
        jobCreatedAt: input.jobCreatedAt,
        tier: input.tier,
      });
      return {
        technician_id: t.technician_id,
        technician_name: t.name,
        score_total: bd?.total ?? 0,
        distance_km: Math.round(distanceKm(t.location, input.jobLocation) * 10) / 10,
        booked_today_pct: Math.round(
          techUtilisationToday(ctx, t.technician_id, input.scheduledTime, input.jobId) * 100,
        ),
        experience_level: t.experience_level,
        recent_job_nearby: technicianHasNearbyJob(
          ctx,
          t.technician_id,
          input.jobLocation,
          input.scheduledTime,
        ),
      };
    });

  // Formula's pick is the safe default.
  let chosenId = formulaTopId;
  let overrode = false;
  let rationale = "";

  let resp: Awaited<ReturnType<typeof callLlm>> | null = null;
  try {
    resp = await callLlm({
      task: "assignment_tiebreak",
      system: SYSTEM,
      structuredInput: {
        reason: trigger.text,
        job: {
          job_id: input.jobId,
          tier: input.tier,
          skill_required: input.skillRequired,
          address: input.address,
        },
        candidates,
      },
      expectedSchema: SCHEMA,
      maxAttempts: 2,
    });
  } catch {
    notes.push("LLM call failed after retry — keeping the formula's top pick.");
  }

  if (resp) {
    try {
      const choice = validateTiebreakChoice(
        resp.data,
        candidates.map((c) => c.technician_id),
      );
      if (choice.chosen_technician_id && choice.chosen_technician_id !== formulaTopId) {
        // Independent re-validation against live state before we accept an
        // override.
        const bd = scoreOneTech(ctx, {
          technicianId: choice.chosen_technician_id,
          jobLocation: input.jobLocation,
          skillRequired: input.skillRequired,
          urgencyHint: input.urgencyHint,
          scheduledTime: input.scheduledTime,
          ignoreJobId: input.jobId,
          jobCreatedAt: input.jobCreatedAt,
          tier: input.tier,
        });
        if (bd) {
          chosenId = choice.chosen_technician_id;
          overrode = true;
          rationale = choice.rationale;
        } else {
          notes.push(
            "LLM picked a different technician but it failed live re-validation — keeping the formula's top pick.",
          );
        }
      } else if (choice.chosen_technician_id === formulaTopId) {
        rationale = choice.rationale;
        notes.push("LLM agreed with the formula's top pick.");
      }
    } catch (e) {
      notes.push(
        `LLM response failed the cross-check (${
          e instanceof Error ? e.message : "invalid"
        }) — keeping the formula's top pick.`,
      );
    }
  }

  // Re-score the final choice so the committed breakdown is from live state.
  const finalBreakdown =
    scoreOneTech(ctx, {
      technicianId: chosenId,
      jobLocation: input.jobLocation,
      skillRequired: input.skillRequired,
      urgencyHint: input.urgencyHint,
      scheduledTime: input.scheduledTime,
      ignoreJobId: input.jobId,
      jobCreatedAt: input.jobCreatedAt,
      tier: input.tier,
    }) ??
    // Should never happen — formulaTopId was eligible — but stay safe.
    ({
      travel: 0,
      skill_fit: 0,
      availability: 0,
      sla_headroom: 0,
      load_balance: 0,
      total: 0,
    } as ScoreBreakdown);

  if (!rationale) {
    rationale = overrode
      ? `Picked ${ctx.getTechnician(chosenId)?.name} over the raw top score.`
      : `Kept the formula's pick (${ctx.getTechnician(chosenId)?.name}) — no candidate was clearly better.`;
  }

  const entry = logDecision(ctx, {
    agent: "AssignmentTiebreakAgent",
    jobId: input.jobId,
    reasoningKind: "llm",
    input: {
      reason: trigger.code,
      reason_text: trigger.text,
      shortlist: candidates,
      formula_top: formulaTopId,
      llm_mode: resp?.mode ?? "not_called",
      cached: resp?.cached ?? false,
    },
    output: {
      chosen_technician_id: chosenId,
      overrode_formula: overrode,
    },
    headline: overrode
      ? `Tie-break: chose ${ctx.getTechnician(chosenId)?.name} over the top score — ${rationale}`
      : `Tie-break: formula's pick (${ctx.getTechnician(chosenId)?.name}) confirmed`,
    outcome: "auto_commit",
    scoreBreakdown: finalBreakdown,
    latencyMs: resp?.latency_ms ?? 0,
    guardrailNotes: [
      ...(resp?.guardrail_notes ?? []),
      "The shortlist was pre-filtered by the rule layer — every candidate already passed certification, working hours and clash checks.",
      ...notes,
      overrode
        ? "The LLM's pick was independently re-scored against live state before it replaced the formula's top pick."
        : "The formula's top pick stands — the LLM did not override it.",
      "Ambiguity-only: this agent never runs when the formula's ranking is clear.",
    ],
  });

  return {
    technicianId: chosenId,
    scoreBreakdown: finalBreakdown,
    overrodeFormula: overrode,
    rationale,
    logId: entry.log_id,
  };
}
