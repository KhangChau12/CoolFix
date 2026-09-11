// ── Capacity/Yield Agent ────────────────────────────────────────────
// Hard-threshold rules (CLAUDE.md §4, §7). No LLM.
// Decides whether the fleet can absorb this booking today, or whether to
// warn / suggest another slot. Thresholds live in RuntimeConfig so the
// Settings screen can tune them (Observability point).
//
// Two layers:
//   1. Fleet-wide caps (total/day, flexible/day) — the original rule.
//   2. Skill-aware saturation — a certified technician can only take a
//      job in one of their own working slots, so "24 jobs/day" hides the
//      real constraint: the number of jobs needing a scarce skill
//      (refrigerant, chiller) against the number of technicians who hold
//      that certification. This layer looks at the next 24h per required
//      skill and flags the booking when that specific pool is already
//      near capacity, with a concrete reason ("3/3 refrigerant slots
//      taken around this time").
//
// When the requested time doesn't fit, the alternative slot is found by
// actually FORECASTING the coming week (`forecastDays`), not by blindly
// adding 24h — a fleet that's full today may also be full tomorrow (a
// filler-heavy Monday, a batch of routine servicing), and pushing every
// overflow to "tomorrow" regardless just relocates the pile-up one day
// forward instead of spreading it. The agent walks forward day by day
// (capped at a week — a tier's own SLA window still bounds how far a
// customer is realistically pushed) and proposes the FIRST day where the
// constraint that triggered the warning actually clears.

import { hoursBetween, nowISO, sgHour } from "@/lib/time";
import { logDecision } from "./log";
import type { CapacityResult } from "./schemas";
import type { SkillTag, Tier } from "@/lib/types";
import type { AgentContext } from "./context";

/** Rough number of appointments one technician can serve in a working day. */
const SLOTS_PER_TECH_PER_DAY = 4;
/** Window (± hours from the proposed slot) treated as "around this time". */
const NEARBY_WINDOW_HOURS = 3;
/** How many calendar days ahead the forecast looks when hunting for a
 *  clear slot — a week is enough runway without pushing a customer to a
 *  date that reads as "we've basically given up on this booking". */
const FORECAST_DAYS = 7;

interface SkillLoad {
  skill: SkillTag;
  /** Technicians certified for this skill. */
  certified_techs: number;
  /** Jobs needing this skill already booked in the next 24h. */
  booked_next_24h: number;
  /** Jobs needing this skill booked within ±NEARBY_WINDOW_HOURS of the proposed slot. */
  booked_nearby: number;
  /** certified_techs × SLOTS_PER_TECH_PER_DAY. */
  day_capacity: number;
  /** certified_techs (one job per technician in a tight ± window). */
  nearby_capacity: number;
}

export function runCapacityAgent(
  ctx: AgentContext,
  args: {
    jobId: string;
    tier: Tier;
    proposedSlotHours: number;
    /** Skills the job needs — from the Job-Intake Agent. */
    skillRequired?: SkillTag[];
  },
): CapacityResult {
  const cfg = ctx.config;
  const now = nowISO();

  // Count jobs scheduled within the next 24h (a rough "today" window).
  const active = ctx.jobs.filter(
    (j) =>
      j.job_id !== args.jobId &&
      j.status !== "completed" &&
      j.status !== "disrupted" &&
      hoursBetween(now, j.scheduled_time) >= -1 &&
      hoursBetween(now, j.scheduled_time) <= 24,
  );
  const totalToday = active.length;
  const flexibleToday = active.filter((j) => j.tier === "flexible").length;

  // ── Skill-aware saturation ──────────────────────────────────────
  const skillLoads: SkillLoad[] = (args.skillRequired ?? []).map((skill) => {
    const certifiedTechs = ctx.technicians.filter((t) =>
      t.skill_tags.includes(skill),
    ).length;
    const needsSkill = active.filter((j) => j.skill_required.includes(skill));
    const bookedNearby = needsSkill.filter(
      (j) =>
        Math.abs(hoursBetween(j.scheduled_time, now) - args.proposedSlotHours) <=
        NEARBY_WINDOW_HOURS,
    ).length;
    return {
      skill,
      certified_techs: certifiedTechs,
      booked_next_24h: needsSkill.length,
      booked_nearby: bookedNearby,
      day_capacity: certifiedTechs * SLOTS_PER_TECH_PER_DAY,
      nearby_capacity: certifiedTechs,
    };
  });

  // The tightest skill decides. "Saturated nearby" = every certified
  // technician for that skill is already booked around the proposed time;
  // "saturated for the day" = the skill's whole-day pool is full.
  const saturatedNearby = skillLoads.filter(
    (s) => s.certified_techs > 0 && s.booked_nearby >= s.nearby_capacity,
  );
  const saturatedDay = skillLoads.filter(
    (s) => s.certified_techs > 0 && s.booked_next_24h >= s.day_capacity,
  );
  const noCertified = skillLoads.filter((s) => s.certified_techs === 0);

  let decision: CapacityResult["decision"] = "accept";
  let reason = "Spare capacity available — accepting the booking normally.";
  let altSlot: number | null = null;

  // 1. A required skill has NO certified technician at all — accept but warn
  //    loudly; the Assignment / Edge-case agents will have to handle it.
  if (noCertified.length > 0) {
    decision = "accept_with_warning";
    reason = `No technician is certified for ${noCertified
      .map((s) => s.skill)
      .join(", ")} — the assignment stage will need a manual or edge-case resolution.`;
  }
  // 2. Skill pool saturated for the whole day → forecast forward and
  //    propose the first day that clears (unless urgent, which we still
  //    take but warn on).
  else if (saturatedDay.length > 0) {
    const s = saturatedDay[0];
    if (args.tier === "urgent") {
      decision = "accept_with_warning";
      reason = `${s.skill} is fully booked today (${s.booked_next_24h}/${s.day_capacity} across ${s.certified_techs} certified technician(s)) — an urgent job is still accepted but a soft job will likely have to move.`;
    } else {
      decision = "suggest_alternative_slot";
      const found = findClearDay(ctx, {
        skill: s.skill,
        startDayOffset: 1,
        proposedSlotHours: args.proposedSlotHours,
      });
      altSlot = found.hours;
      reason = found.dayOffset === 1
        ? `${s.skill} is fully booked today (${s.booked_next_24h}/${s.day_capacity} across ${s.certified_techs} certified technician(s)) — proposing a slot tomorrow.`
        : `${s.skill} is fully booked today AND the next ${found.dayOffset - 1} day(s) — proposing a slot ${found.dayOffset} days out, the earliest day with room.`;
    }
  }
  // 3. Skill pool saturated only around the requested time → nudge later
  //    the same day.
  else if (saturatedNearby.length > 0 && args.tier !== "urgent") {
    const s = saturatedNearby[0];
    decision = "suggest_alternative_slot";
    altSlot = args.proposedSlotHours + NEARBY_WINDOW_HOURS + 1;
    reason = `All ${s.certified_techs} ${s.skill} technician(s) are booked around this time (${s.booked_nearby}/${s.nearby_capacity}) — proposing a slightly later slot the same day.`;
  }
  // 4. Fall back to the original fleet-wide caps.
  else if (args.tier === "flexible" && flexibleToday >= cfg.capacityFlexiblePerDay) {
    decision = "suggest_alternative_slot";
    const found = findClearDay(ctx, {
      startDayOffset: 1,
      proposedSlotHours: Math.max(args.proposedSlotHours, 30),
      fleetFlexibleCap: cfg.capacityFlexiblePerDay,
    });
    altSlot = found.hours;
    reason = found.dayOffset === 1
      ? `Daily cap of ${cfg.capacityFlexiblePerDay} Flexible jobs reached — proposing a later slot.`
      : `Daily cap of ${cfg.capacityFlexiblePerDay} Flexible jobs reached for the next ${found.dayOffset - 1} day(s) too — proposing a slot ${found.dayOffset} days out.`;
  } else if (totalToday >= cfg.capacityTotalPerDay) {
    decision =
      args.tier === "urgent" ? "accept_with_warning" : "suggest_alternative_slot";
    if (decision === "accept_with_warning") {
      reason = `Schedule nearly full (${totalToday}/${cfg.capacityTotalPerDay}) but Urgent jobs are still accepted — a soft job may need to move.`;
    } else {
      const found = findClearDay(ctx, {
        startDayOffset: 1,
        proposedSlotHours: args.proposedSlotHours,
        fleetTotalCap: cfg.capacityTotalPerDay,
      });
      altSlot = found.hours;
      reason = found.dayOffset === 1
        ? `Schedule full (${totalToday}/${cfg.capacityTotalPerDay}) — proposing a slot on the next day.`
        : `Schedule full (${totalToday}/${cfg.capacityTotalPerDay}) for the next ${found.dayOffset - 1} day(s) too — proposing a slot ${found.dayOffset} days out, the earliest day with room.`;
    }
  } else if (totalToday >= cfg.capacityTotalPerDay * 0.8) {
    decision = "accept_with_warning";
    reason = `Schedule at ${Math.round(
      (totalToday / cfg.capacityTotalPerDay) * 100,
    )}% capacity — accepting but monitoring.`;
  }

  const out: CapacityResult = {
    decision,
    reason,
    alternative_slot_hours: altSlot,
    utilisation: { total_today: totalToday, flexible_today: flexibleToday },
  };

  const skillSummary = skillLoads
    .map(
      (s) =>
        `${s.skill}: ${s.booked_next_24h}/${s.day_capacity} today · ${s.booked_nearby}/${s.nearby_capacity} nearby · ${s.certified_techs} certified`,
    )
    .join(" | ");

  logDecision(ctx, {
    agent: "CapacityAgent",
    jobId: args.jobId,
    reasoningKind: "rule",
    input: {
      tier: args.tier,
      proposed_slot_hours: args.proposedSlotHours,
      skill_required: args.skillRequired ?? [],
      total_today: totalToday,
      flexible_today: flexibleToday,
      caps: { total: cfg.capacityTotalPerDay, flexible: cfg.capacityFlexiblePerDay },
      skill_load: skillLoads,
    },
    output: out as unknown as Record<string, unknown>,
    headline:
      decision === "accept"
        ? `Capacity: accept (${totalToday}/${cfg.capacityTotalPerDay} today)`
        : `Capacity: ${decision} — ${reason.split(" — ")[0]}`,
    outcome: decision === "accept" ? "auto_commit" : "info",
    guardrailNotes: [
      "Hard thresholds from config — no LLM call.",
      skillLoads.length > 0
        ? `Skill-aware check — ${skillSummary}.`
        : "No skill list yet — fleet-wide caps only.",
      decision === "suggest_alternative_slot"
        ? `Alternative slot found by forecasting up to ${FORECAST_DAYS} days ahead, not a blind +24h — the first day where the triggering constraint actually clears.`
        : "",
    ].filter(Boolean),
  });

  return out;
}

// ── Multi-day forecast ──────────────────────────────────────────────
// Buckets jobs by Singapore calendar day and re-runs the SAME saturation
// check that triggered the warning, one day at a time, until it clears —
// so "suggest_alternative_slot" means "the earliest day that's actually
// workable", not "tomorrow, whether or not tomorrow is worse".

interface ClearDayResult {
  /** Calendar days from today (1 = tomorrow) the clear slot was found at. */
  dayOffset: number;
  /** Hours-from-now to pass back into the scheduling snap, same unit the
   *  rest of the pipeline already uses for `proposedSlotHours`. */
  hours: number;
}

function findClearDay(
  ctx: AgentContext,
  args: {
    proposedSlotHours: number;
    startDayOffset: number;
    skill?: SkillTag;
    fleetTotalCap?: number;
    fleetFlexibleCap?: number;
  },
): ClearDayResult {
  const now = nowISO();
  const nowHour = sgHour(now);

  for (let dayOffset = args.startDayOffset; dayOffset <= FORECAST_DAYS; dayOffset++) {
    // The 24h window this day represents, anchored to the same hour of day
    // as `now` so it lines up with how `active` is computed elsewhere (a
    // rolling 24h window, not a strict midnight-to-midnight calendar day).
    const dayJobs = ctx.jobs.filter((j) => {
      if (j.status === "completed" || j.status === "disrupted") return false;
      const h = hoursBetween(now, j.scheduled_time);
      return h >= (dayOffset - 1) * 24 - 1 && h <= dayOffset * 24;
    });

    let clear = true;
    if (args.skill) {
      const certifiedTechs = ctx.technicians.filter((t) =>
        t.skill_tags.includes(args.skill!),
      ).length;
      const dayCapacity = certifiedTechs * SLOTS_PER_TECH_PER_DAY;
      const booked = dayJobs.filter((j) => j.skill_required.includes(args.skill!)).length;
      clear = certifiedTechs === 0 || booked < dayCapacity;
    }
    if (clear && args.fleetTotalCap != null) {
      clear = dayJobs.length < args.fleetTotalCap;
    }
    if (clear && args.fleetFlexibleCap != null) {
      const flexCount = dayJobs.filter((j) => j.tier === "flexible").length;
      clear = flexCount < args.fleetFlexibleCap;
    }

    if (clear) {
      // Land in mid-morning local time on the clear day, not literally
      // "same hour as now" — a booking made at 23:00 shouldn't propose a
      // 23:00 slot two days out. hoursToNextMorning gets us to ~09:00 SGT
      // on that day; dayOffset*24 keeps the coarse day placement.
      const hoursToMorning = ((9 - nowHour + 24) % 24) || 24;
      return { dayOffset, hours: dayOffset * 24 + hoursToMorning };
    }
  }

  // Nothing clear within the forecast window — fall back to the simple
  // +24h the caller would have used anyway; downstream capacity/assignment
  // logic still enforces every real constraint regardless of this slot.
  return { dayOffset: args.startDayOffset, hours: args.proposedSlotHours + 24 };
}
