// ── Assignment scoring engine ──────────────────────────────────────
// RULE-based, no LLM. This is the transparent core of the Assignment
// Agent, pulled into its own module so the tie-break and edge-case agents
// can score a candidate the exact same way (no second, drifting copy of
// the maths).
//
// The old formula was
//
//   score = w1·(1/dist) + w2·skill_bonus + w3·urgency + w4·(1/workload)
//
// and it did not hold up: the terms had different units and wildly
// different ranges, so `skill_bonus` and `urgency` were near-constant
// offsets that never separated one candidate from another — only distance
// and workload actually moved the ranking, and both as hyperbolae that
// over-weighted "closest technician" past all reason.
//
// This version scores five components a real dispatch desk cares about,
// each a pure function returning [0, 1]:
//
//   travel        marginal detour this job adds to the technician's route
//                 today (not straight-line distance from their home base)
//   skillFit      certification (already a hard constraint) + the right
//                 seniority for the job's complexity, minus a small
//                 penalty for burning an over-qualified senior on easy work
//   availability  hours left in the technician's shift after this job
//                 (from real estimated job durations, not a job count)
//   slaHeadroom   how close the job is to its SLA deadline — and 0 for any
//                 candidate whose schedule would make it miss that deadline
//   loadBalance   pulls work toward technicians below the fleet's median
//                 utilisation today
//
// travel and availability are min-max normalised WITHIN the candidate pool
// for a job, so "closest of the pool" scores 1 and "furthest of the pool"
// scores 0 — the component always separates candidates, whether the pool
// is all-nearby or all-far. The others are already absolute [0, 1].
//
// Final score = Σ policy[tier][component] · component, where the tier's
// policy weights sum to 1 — so `total` is itself in [0, 1] and reads as
// "how good a match is this technician for this job". Policy per tier is
// the business lever (DISPATCH_POLICY / RuntimeConfig.dispatchPolicy).

import { distanceKm, estimateDriveMinutes } from "@/lib/geo";
import {
  addHours,
  findTimeClash,
  hoursBetween,
  isWithinWorkingHours,
  sameSgDay,
} from "@/lib/time";
import type {
  Job,
  ScoreBreakdown,
  ScoreComponent,
  SkillTag,
  Technician,
  Tier,
} from "@/lib/types";
import {
  DISPATCH_POLICY,
  TIER_META,
  estimatedJobMinutes,
  jobIsComplex,
} from "@/lib/types";
import type { AgentContext } from "./context";

// ── Tunables ───────────────────────────────────────────────────────
/** A detour at or above this many minutes scores 0 on `travel` before
 *  pool-normalisation. */
const MAX_DETOUR_MIN = 45;
/** Junior technician's `skillFit` seniority term on a complex job. */
const JUNIOR_COMPLEX_LEVEL = 0.4;
const EPS = 1e-6;

export interface ScoreArgs {
  technicianId: string;
  jobLocation: { lat: number; lng: number };
  skillRequired: SkillTag[];
  scheduledTime: string;
  /** The job being scored — excluded from clash / route / load maths. */
  ignoreJobId: string;
  /** When the job was created — needed for the SLA deadline. Falls back to
   *  `scheduledTime` if unknown (treats it as "just booked"). */
  jobCreatedAt?: string;
  tier: Tier;
}

/**
 * Score ONE technician for a job, without pool-normalisation (each of
 * `travel` / `availability` is scored on its own absolute curve). Returns
 * null if the technician fails a hard constraint at `scheduledTime`:
 * certification, working hours, a schedule clash, or route infeasibility
 * (cannot reach this job from their previous one in time).
 *
 * The orchestrator's normal path uses `scorePool` instead, which calls this
 * for every candidate and THEN min-max normalises travel + availability
 * across the pool. `scoreOneTech` is the entry point for the tie-break /
 * edge-case agents, which re-score a single already-chosen candidate.
 */
export function scoreOneTech(
  ctx: AgentContext,
  args: ScoreArgs,
): ScoreBreakdown | null {
  const raw = rawComponentsForTech(ctx, args);
  if (!raw) return null;
  return weight(
    {
      travel: raw.travelAbs,
      skillFit: raw.skillFit,
      availability: raw.availabilityAbs,
      slaHeadroom: raw.slaHeadroom,
      loadBalance: raw.loadBalance,
    },
    policyFor(ctx, args.tier),
    raw.rawFacts,
  );
}

export interface PoolEntry {
  technician_id: string;
  breakdown: ScoreBreakdown;
}

/**
 * Score every technician in `technicianIds` for the job, dropping any that
 * fail a hard constraint, and min-max normalise `travel` + `availability`
 * across the survivors before applying the tier policy weights. Returns the
 * scored pool sorted best-first.
 */
export function scorePool(
  ctx: AgentContext,
  technicianIds: string[],
  common: Omit<ScoreArgs, "technicianId">,
): PoolEntry[] {
  const rawByTech = new Map<
    string,
    NonNullable<ReturnType<typeof rawComponentsForTech>>
  >();
  for (const id of technicianIds) {
    const raw = rawComponentsForTech(ctx, { ...common, technicianId: id });
    if (raw) rawByTech.set(id, raw);
  }
  if (rawByTech.size === 0) return [];

  const travels = [...rawByTech.values()].map((r) => r.travelAbs);
  const avails = [...rawByTech.values()].map((r) => r.availabilityAbs);
  const normTravel = minMaxNormaliser(travels);
  const normAvail = minMaxNormaliser(avails);

  const policy = policyFor(ctx, common.tier);
  const pool: PoolEntry[] = [];
  for (const [id, raw] of rawByTech) {
    const breakdown = weight(
      {
        travel: normTravel(raw.travelAbs),
        skillFit: raw.skillFit,
        availability: normAvail(raw.availabilityAbs),
        slaHeadroom: raw.slaHeadroom,
        loadBalance: raw.loadBalance,
      },
      policy,
      raw.rawFacts,
    );
    pool.push({ technician_id: id, breakdown });
  }
  pool.sort((a, b) => b.breakdown.total - a.breakdown.total);
  return pool;
}

/**
 * Route-feasibility hard constraint, exported so the Assignment Agent can
 * show it as a rejection reason and the Disruption Agent can reuse it.
 *
 * It only rejects a MID-ROUTE impossibility: the technician already has an
 * earlier job that day and cannot finish it, drive here, and arrive before
 * this job starts. The FIRST stop of the day is never rejected on route
 * grounds — a technician plans their morning around their first
 * appointment and leaves home accordingly; a dispatch desk assigns the
 * first job of the day the same way.
 */
export function canReachInTime(
  ctx: AgentContext,
  techId: string,
  jobLocation: { lat: number; lng: number },
  scheduledTime: string,
  ignoreJobId: string,
): boolean {
  const t = ctx.getTechnician(techId);
  if (!t) return false;
  const prev = previousJobSameDay(ctx, techId, scheduledTime, ignoreJobId);
  if (!prev) return true; // first stop of the day — always feasible
  const departISO = addMinutes(
    prev.scheduled_time,
    estimatedJobMinutes(prev.skill_required),
  );
  const driveMin = estimateDriveMinutes(prev.location, jobLocation, departISO);
  const arriveISO = addMinutes(departISO, driveMin);
  // A few minutes of slack — the estimate is coarse, don't reject on 1 min.
  return (
    new Date(arriveISO).getTime() <=
    new Date(scheduledTime).getTime() + 5 * 60_000
  );
}

// ── Raw per-technician components (pre pool-normalisation) ───────────

interface RawComponents {
  travelAbs: number; // [0,1], 1 = no detour
  availabilityAbs: number; // [0,1], 1 = whole shift free after this job
  skillFit: number; // [0,1] absolute
  slaHeadroom: number; // [0,1] absolute
  loadBalance: number; // [0,1] absolute
  rawFacts: NonNullable<ScoreBreakdown["raw"]>;
}

function rawComponentsForTech(
  ctx: AgentContext,
  args: ScoreArgs,
): RawComponents | null {
  const t = ctx.getTechnician(args.technicianId);
  if (!t) return null;

  // ── Hard constraints (same set as the old scoreOneTech, plus route) ──
  if (!args.skillRequired.every((s) => t.skill_tags.includes(s))) return null;
  if (!isWithinWorkingHours(t.working_hours, args.scheduledTime)) return null;
  if (
    findTimeClash(ctx.jobs, t.technician_id, args.scheduledTime, args.ignoreJobId)
  ) {
    return null;
  }
  if (
    !canReachInTime(
      ctx,
      t.technician_id,
      args.jobLocation,
      args.scheduledTime,
      args.ignoreJobId,
    )
  ) {
    return null;
  }

  const thisJobMin = estimatedJobMinutes(args.skillRequired);

  // ── travel: marginal detour vs. the technician's existing route ──────
  const detourMin = marginalDetourMinutes(
    ctx,
    t,
    args.jobLocation,
    args.scheduledTime,
    args.ignoreJobId,
  );
  const travelAbs = 1 - clamp01(detourMin / MAX_DETOUR_MIN);

  // ── availability: shift hours left after taking this job ────────────
  const shiftMin = shiftMinutes(t.working_hours);
  const usedMin = usedShiftMinutes(ctx, t.technician_id, args.scheduledTime, args.ignoreJobId);
  const remainingMin = shiftMin - usedMin - thisJobMin;
  const availabilityAbs = clamp01(remainingMin / Math.max(shiftMin, 1));

  // ── skillFit: certification (given) + seniority-for-complexity ──────
  const complex = jobIsComplex(args.skillRequired, args.tier);
  const levelTerm =
    !complex || t.experience_level === "senior" ? 1 : JUNIOR_COMPLEX_LEVEL;
  const extraSkills = t.skill_tags.filter(
    (s) => !args.skillRequired.includes(s),
  ).length;
  const overQual = complex
    ? 0
    : clamp01(extraSkills / Math.max(t.skill_tags.length, 1));
  const skillFit = 0.55 * 1 + 0.25 * levelTerm + 0.2 * (1 - overQual);

  // ── slaHeadroom: deadline pressure, 0 if this tech would miss it ────
  const createdAt = args.jobCreatedAt ?? args.scheduledTime;
  const slaHours = TIER_META[args.tier].slaHours;
  const deadlineISO = addHours(createdAt, slaHours);
  const hoursToDeadline = hoursBetween(args.scheduledTime, deadlineISO);
  const wouldMiss =
    new Date(args.scheduledTime).getTime() > new Date(deadlineISO).getTime();
  const slaHeadroom = wouldMiss
    ? 0
    : clamp01(1 - hoursToDeadline / Math.max(slaHours, 1));

  // ── loadBalance: this tech vs. the fleet median utilisation today ───
  const utilToday = usedMin / Math.max(shiftMin, 1);
  const medianUtil = fleetMedianUtil(ctx, args.scheduledTime);
  const loadBalance = clamp01(0.5 + (medianUtil - utilToday));

  return {
    travelAbs,
    availabilityAbs,
    skillFit: clamp01(skillFit),
    slaHeadroom,
    loadBalance,
    rawFacts: {
      detour_min: round1(detourMin),
      util_pct: Math.round(utilToday * 100),
      hours_to_deadline: wouldMiss ? 0 : round1(hoursToDeadline),
    },
  };
}

// ── Component helpers ──────────────────────────────────────────────

/**
 * Extra driving minutes this job adds to the technician's day: the detour
 * of visiting `jobLocation` between the job that precedes it and the job
 * that follows it in their schedule. If it is the first or last stop, only
 * the one leg that exists is counted. A job that sits right on the existing
 * route can score a detour near 0.
 */
function marginalDetourMinutes(
  ctx: AgentContext,
  t: Technician,
  jobLocation: { lat: number; lng: number },
  scheduledTime: string,
  ignoreJobId: string,
): number {
  const prev = previousJobSameDay(ctx, t.technician_id, scheduledTime, ignoreJobId);
  const next = nextJobSameDay(ctx, t.technician_id, scheduledTime, ignoreJobId);
  const fromLoc = prev ? prev.location : t.location;
  const toLoc = next ? next.location : null;

  const legIn = estimateDriveMinutes(fromLoc, jobLocation, scheduledTime);
  if (!toLoc) {
    // First and/or last stop of the day: the only cost is the one leg that
    // exists — driving to the job from the previous stop (or from base).
    return legIn;
  }
  const legOut = estimateDriveMinutes(jobLocation, toLoc, scheduledTime);
  const direct = estimateDriveMinutes(fromLoc, toLoc, scheduledTime);
  return Math.max(0, legIn + legOut - direct);
}

/** Sum of estimated on-site minutes for `techId`'s other jobs on the same
 *  SGT day as `scheduledTime`. */
function usedShiftMinutes(
  ctx: AgentContext,
  techId: string,
  scheduledTime: string,
  ignoreJobId: string,
): number {
  return sameDayJobs(ctx, techId, scheduledTime, ignoreJobId).reduce(
    (sum, j) => sum + estimatedJobMinutes(j.skill_required),
    0,
  );
}

/**
 * Real utilisation [0,1] for `techId` on the SGT day of `scheduledTime` —
 * hours already committed that day ÷ their shift length. Exported so any
 * agent that needs "is this technician's day actually full" (the
 * tie-break agent's "strained lone candidate" check, for one) reads the
 * same number the scoring engine's own `loadBalance` component uses,
 * instead of falling back to `Technician.current_workload` — a lifetime
 * running counter seeded once and bumped +1/-1 forever with no day
 * boundary, which stopped meaning "today" the moment the seed grew from
 * 10 hand-placed jobs to a real multi-day schedule (see
 * coolfix-pipeline-audit-8agent, đợt 14/15).
 */
export function techUtilisationToday(
  ctx: AgentContext,
  techId: string,
  scheduledTime: string,
  ignoreJobId: string,
): number {
  const t = ctx.getTechnician(techId);
  if (!t) return 0;
  const used = usedShiftMinutes(ctx, techId, scheduledTime, ignoreJobId);
  return clamp01(used / Math.max(shiftMinutes(t.working_hours), 1));
}

function fleetMedianUtil(ctx: AgentContext, scheduledTime: string): number {
  const utils = ctx.technicians.map((t) => {
    const shiftMin = shiftMinutes(t.working_hours);
    const usedMin = sameDayJobs(ctx, t.technician_id, scheduledTime, "__none__").reduce(
      (s, j) => s + estimatedJobMinutes(j.skill_required),
      0,
    );
    return usedMin / Math.max(shiftMin, 1);
  });
  return median(utils);
}

// ── Schedule lookups ───────────────────────────────────────────────

function sameDayJobs(
  ctx: AgentContext,
  techId: string,
  dayAnchorISO: string,
  ignoreJobId: string,
): Job[] {
  return ctx.jobs.filter(
    (j) =>
      j.job_id !== ignoreJobId &&
      j.assigned_technician_id === techId &&
      j.status !== "completed" &&
      j.status !== "disrupted" &&
      sameSgDay(j.scheduled_time, dayAnchorISO),
  );
}

function previousJobSameDay(
  ctx: AgentContext,
  techId: string,
  scheduledTime: string,
  ignoreJobId: string,
): Job | null {
  const before = sameDayJobs(ctx, techId, scheduledTime, ignoreJobId)
    .filter((j) => new Date(j.scheduled_time).getTime() < new Date(scheduledTime).getTime())
    .sort((a, b) => b.scheduled_time.localeCompare(a.scheduled_time));
  return before[0] ?? null;
}

function nextJobSameDay(
  ctx: AgentContext,
  techId: string,
  scheduledTime: string,
  ignoreJobId: string,
): Job | null {
  const after = sameDayJobs(ctx, techId, scheduledTime, ignoreJobId)
    .filter((j) => new Date(j.scheduled_time).getTime() > new Date(scheduledTime).getTime())
    .sort((a, b) => a.scheduled_time.localeCompare(b.scheduled_time));
  return after[0] ?? null;
}

// ── Small maths ────────────────────────────────────────────────────

function policyFor(
  ctx: AgentContext,
  tier: Tier,
): Record<ScoreComponent, number> {
  const p = ctx.config.dispatchPolicy?.[tier] ?? DISPATCH_POLICY[tier];
  // Normalise defensively so `total` stays in [0,1] even if a stored config
  // row's weights don't sum to exactly 1.
  const sum = Object.values(p).reduce((s, v) => s + (Number(v) || 0), 0) || 1;
  return {
    travel: p.travel / sum,
    skillFit: p.skillFit / sum,
    availability: p.availability / sum,
    slaHeadroom: p.slaHeadroom / sum,
    loadBalance: p.loadBalance / sum,
  };
}

function weight(
  comps: Record<ScoreComponent, number>,
  policy: Record<ScoreComponent, number>,
  rawFacts: NonNullable<ScoreBreakdown["raw"]>,
): ScoreBreakdown {
  const travel = round3(comps.travel * policy.travel);
  const skill_fit = round3(comps.skillFit * policy.skillFit);
  const availability = round3(comps.availability * policy.availability);
  const sla_headroom = round3(comps.slaHeadroom * policy.slaHeadroom);
  const load_balance = round3(comps.loadBalance * policy.loadBalance);
  return {
    travel,
    skill_fit,
    availability,
    sla_headroom,
    load_balance,
    total: round3(travel + skill_fit + availability + sla_headroom + load_balance),
    raw: rawFacts,
  };
}

/** Returns a fn mapping a raw value to [0,1] by min-max over `values`. If
 *  every value is equal the component can't separate candidates — return
 *  1 for all (neutral, lets the other components decide). */
function minMaxNormaliser(values: number[]): (v: number) => number {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max - min < EPS) return () => 1;
  return (v: number) => clamp01((v - min) / (max - min));
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function shiftMinutes(wh: { start: string; end: string }): number {
  const [sh, sm] = wh.start.split(":").map(Number);
  const [eh, em] = wh.end.split(":").map(Number);
  return Math.max(0, eh * 60 + em - (sh * 60 + sm));
}

function addMinutes(iso: string, min: number): string {
  return new Date(new Date(iso).getTime() + min * 60_000).toISOString();
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
