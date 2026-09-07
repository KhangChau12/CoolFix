// ── Disruption Agent ────────────────────────────────────────────────
// LLM call. Triggered when a new job needs a slot already held by an
// existing job.
//
// We mechanically search a real space of candidate re-plans — every
// skilled technician × a ladder of candidate time offsets, not a handful
// of hardcoded formulas — with every hard constraint (skill, freeze
// window, no double-booking, working hours) enforced AT GENERATION TIME,
// so nothing illegal ever enters the pool. The LLM is then handed a
// pre-filtered top-N shortlist and asked only to pick/rank by option_id +
// write summaries — it is never allowed to return its own moves or
// trade-off numbers, closing off the main way an LLM could "invent" a
// slot. Whatever it picks is INDEPENDENTLY re-validated against live
// constraints one more time before being offered to the coordinator or
// auto-committed; if that fails (or the LLM response is malformed), the
// pipeline falls back to the best pre-computed mechanical option. No
// retry loop beyond one bounded retry for malformed JSON — a safe
// deterministic answer is always available.
//
// Freeze window is an ABSOLUTE hard constraint, enforced the same way the
// skill-certification check is: a candidate move is dropped entirely if
// its destination slot would land on — or bump — a job that is already
// past its freeze point. There is no "Emergency Override" escape hatch in
// the automatic pipeline; the freeze window is treated as already having
// happened, full stop. (A coordinator can still hand-edit a frozen job
// outside this pipeline in a genuine emergency, but the agents never
// propose it.)
//
// Risk-calibrated autonomy (CLAUDE.md §3.2, §4):
//   • low impact  → auto-commit
//   • impact over threshold → HITL approval gate (kind: "standard")
//   • zero clean options survive generation → no re-plan is proposed at
//     all; the incoming job is reported unassignable so the
//     customer/coordinator can pick a different time instead.

import { callLlm } from "@/lib/llm";
import { distanceKm } from "@/lib/geo";
import {
  addHours,
  findTimeClash,
  hoursBetween,
  isFrozen,
  isWithinWorkingHours,
  nowISO,
  snapToServiceHours,
} from "@/lib/time";
import { logDecision } from "./log";
import { validateDisruptionLlmChoice } from "./schemas";
import type { AssignmentResult } from "./schemas";
import type { Job, ReplanOption } from "@/lib/types";
import type { AgentContext } from "./context";

const TOP_N_FOR_LLM = 6;
const SLOT_OFFSETS_HOURS = [1, 2, 3, 4, 24, 25, 26, 48];

const SYSTEM = `You are the Disruption Agent for CoolFix. A new job needs a time slot currently held by another job.
You ARE GIVEN a shortlist of pre-computed candidate re-plans (candidate_moves) with numeric trade-offs.
Every option has ALREADY been verified to respect every hard constraint (certification, freeze window, no
double-booking, working hours) — these are not yours to weigh or re-check.
Your job: DO NOT invent a schedule. You may ONLY reference option_id values that appear in candidate_moves below.
Never invent new ids, times, technicians, or trade-off numbers — you are not asked for and must not return moves
or trade_offs.
- ranked_option_ids: the given option_ids, ordered best-to-worst by your judgement.
- summaries: a short, plain-English summary of each option for the coordinator, keyed by option_id.
- recommended_option_id: MUST be one of the given option_ids — the least harmful
  (priority order: fewer SLA breaches > fewer customers affected > less added travel).
- injection_attempt: always false here (there is no customer input).`;

const SCHEMA = `{"ranked_option_ids":string[],"summaries":{"<option_id>":string},"recommended_option_id":string,"injection_attempt":boolean}`;

export interface DisruptionInput {
  incomingJobId: string;
  assignment: AssignmentResult; // must carry a conflict
}

export interface DisruptionOutcome {
  logId: string;
  options: ReplanOption[];
  recommendedOptionId: string | null;
  needsApproval: boolean;
  /** Always "standard" — freeze window is an absolute constraint, never overridden by the pipeline. */
  approvalKind: "standard";
  autoChosenOptionId: string | null;
  /** True if the generation-time search found zero constraint-safe candidates — no re-plan is possible. */
  noCleanOption: boolean;
  /** Observability: did the LLM's pick survive re-validation and get used, or did we fall back? */
  llmChoiceAccepted: boolean;
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

  // ── Mechanically search the candidate space ───────────────────────
  // Every candidate returned here already passed skill + freeze + clash +
  // working-hours checks — see buildCandidateMoves.
  const pool = buildCandidateMoves(ctx, {
    bumped,
    originalTechId: tech.technician_id,
    now,
  });

  // ── No clean option survives the search → stop, no re-plan. ────────
  if (pool.length === 0) {
    const entry = logDecision(ctx, {
      agent: "DisruptionAgent",
      jobId: incoming.job_id,
      reasoningKind: "rule",
      input: {
        incoming_job: incoming.job_id,
        bumped_job: bumped.job_id,
        technician: tech.name,
      },
      output: { result: "no_clean_option" },
      headline: "No re-plan possible — every technician/slot combination fails a hard constraint",
      outcome: "requires_approval",
      requiresApproval: true,
      guardrailNotes: [
        "Freeze window, certification, clash and working-hours are absolute constraints — none were relaxed to find a slot.",
        "No Emergency Override was proposed: the pipeline never offers to touch a frozen job automatically.",
      ],
    });
    return {
      logId: entry.log_id,
      options: [],
      recommendedOptionId: null,
      needsApproval: false,
      approvalKind: "standard",
      autoChosenOptionId: null,
      noCleanOption: true,
      llmChoiceAccepted: false,
    };
  }

  const ranked = [...pool].sort((a, b) => a.heuristic_cost - b.heuristic_cost);
  const shortlist = ranked.slice(0, TOP_N_FOR_LLM);
  const bestMechanical = ranked[0];

  // ── LLM picks/ranks from the shortlist — never invents moves ──────
  const shortlistForLlm = shortlist.map((c) => ({
    option_id: c.option_id,
    label: c.label,
    moves: c.moves,
    trade_offs: c.trade_offs,
  }));

  const llmCallArgs = {
    task: "disruption_replan" as const,
    system: SYSTEM,
    structuredInput: {
      incoming_job: {
        job_id: incoming.job_id,
        customer_name: incoming.customer_name,
        tier: incoming.tier,
      },
      conflict,
      candidate_moves: shortlistForLlm,
    },
    expectedSchema: SCHEMA,
    // Retry once, but ONLY for malformed-JSON responses (handled inside
    // callLlm itself) — never for a semantically-invalid-but-parseable
    // response, which is caught below and falls back immediately instead.
    maxAttempts: 2,
  };

  let chosen: CandidateMove = bestMechanical;
  let llmAccepted = false;
  let summaries: Record<string, string> = {};
  const rejectionNotes: string[] = [];
  let resp: Awaited<ReturnType<typeof callLlm>> | null = null;

  try {
    resp = await callLlm(llmCallArgs);
  } catch {
    rejectionNotes.push("LLM call failed after retry (malformed JSON) — using best mechanical option instead.");
  }

  if (resp) {
    try {
      const llmChoice = validateDisruptionLlmChoice(
        resp.data,
        shortlist.map((c) => c.option_id),
      );
      summaries = llmChoice.summaries;
      // Membership in the shortlist is already guaranteed by the validator.
      const candidate = shortlist.find((c) => c.option_id === llmChoice.recommended_option_id)!;
      const revalidation = revalidateCandidate(ctx, candidate, now);
      if (revalidation.ok) {
        chosen = candidate;
        llmAccepted = true;
      } else {
        rejectionNotes.push(
          `LLM-recommended option ${candidate.option_id} rejected on re-validation (${revalidation.reason}) — using best mechanical option instead.`,
        );
      }
    } catch {
      // Parseable JSON but it references an id we never offered, or fails
      // shape validation — a logic error, not a JSON error. No retry:
      // fall back immediately to the pre-verified mechanical best.
      rejectionNotes.push("LLM response referenced an option we did not offer or failed schema validation — using best mechanical option instead.");
    }
  }

  const options: ReplanOption[] = shortlist.map((c) => ({
    option_id: c.option_id,
    label: c.label,
    summary: summaries[c.option_id] ?? summariseOption(c),
    moves: c.moves,
    trade_offs: c.trade_offs,
    recommended: c.option_id === chosen.option_id,
  }));

  // ── Risk calibration ────────────────────────────────────────────
  // Freeze window is already guaranteed clean by generation-time filtering
  // — the only thing left to calibrate is customer/travel/SLA impact.
  const overThreshold =
    chosen.trade_offs.customers_affected > cfg.hitlMaxCustomersAffected ||
    chosen.trade_offs.total_added_travel_km > cfg.hitlMaxAddedTravelKm ||
    chosen.trade_offs.sla_breaches > 0;

  const needsApproval = overThreshold;

  const entry = logDecision(ctx, {
    agent: "DisruptionAgent",
    jobId: incoming.job_id,
    reasoningKind: "llm",
    input: {
      incoming_job: incoming.job_id,
      bumped_job: bumped.job_id,
      technician: tech.name,
      pool_size: pool.length,
      shortlist_size: shortlist.length,
      llm_mode: resp?.mode ?? "failed",
      cached: resp?.cached ?? false,
    },
    output: {
      chosen_option_id: chosen.option_id,
      needs_approval: needsApproval,
      llm_choice_accepted: llmAccepted,
    },
    headline: needsApproval
      ? `Approval needed: re-plan affects ${chosen.trade_offs.customers_affected} customer(s)`
      : `Auto-commit re-plan: ${chosen.label}`,
    outcome: needsApproval ? "requires_approval" : "auto_commit",
    requiresApproval: needsApproval,
    replanOptions: options,
    latencyMs: resp?.latency_ms ?? 0,
    guardrailNotes: [
      ...(resp?.guardrail_notes ?? []),
      `Searched ${pool.length} technician/slot combination(s), all pre-verified against every hard constraint before reaching this point.`,
      ...rejectionNotes,
      llmAccepted
        ? "LLM's pick passed independent re-validation and was used."
        : "Fell back to the best pre-computed mechanical option.",
      overThreshold
        ? "Impact exceeds the config threshold — routing to HITL."
        : "Low impact — eligible for auto-commit.",
    ],
  });

  return {
    logId: entry.log_id,
    options,
    recommendedOptionId: chosen.option_id,
    needsApproval,
    approvalKind: "standard",
    autoChosenOptionId: needsApproval ? null : chosen.option_id,
    noCleanOption: false,
    llmChoiceAccepted: llmAccepted,
  };
}

// ── Post-LLM re-validation — never trust the LLM's pick blindly ──────

interface RevalidationResult {
  ok: boolean;
  reason?: string;
}

/**
 * Independently re-checks a candidate's moves against LIVE constraint
 * state (skill, freeze, clash, working hours) using the exact same
 * predicates as generation time. This is deliberate defense-in-depth, not
 * redundant with generation-time filtering: the LLM's response is never
 * trusted just because it referenced a known option_id.
 */
function revalidateCandidate(ctx: AgentContext, candidate: CandidateMove, now: string): RevalidationResult {
  for (const move of candidate.moves) {
    const job = ctx.getJob(move.job_id);
    if (!job) return { ok: false, reason: `move references unknown job ${move.job_id}` };

    const moveTech = ctx.getTechnician(move.technician_id);
    if (!moveTech) return { ok: false, reason: `move references unknown technician ${move.technician_id}` };

    const hasSkill = job.skill_required.every((s) => moveTech.skill_tags.includes(s));
    if (!hasSkill) return { ok: false, reason: `${moveTech.name} lacks required skill` };

    if (!moveIsFreezeSafe(ctx, move, now)) {
      return { ok: false, reason: "move touches a frozen job" };
    }

    const clashJobId = findTimeClash(ctx.jobs, moveTech.technician_id, move.to_time, move.job_id);
    if (clashJobId) return { ok: false, reason: `would clash with job ${clashJobId}` };

    if (!isWithinWorkingHours(moveTech.working_hours, move.to_time)) {
      return { ok: false, reason: `outside ${moveTech.name}'s working hours` };
    }
  }
  return { ok: true };
}

/**
 * True if `move.to_time` on `move.technician_id` does not collide with a
 * DIFFERENT job that is already frozen, and the moved job itself is not
 * already frozen at its old slot. Shared by generation-time filtering and
 * post-LLM re-validation — single source of truth for "freeze is absolute."
 */
function moveIsFreezeSafe(
  ctx: AgentContext,
  move: { job_id: string; to_time: string; technician_id: string },
  now: string,
): boolean {
  const collision = ctx.jobs.find(
    (j) =>
      j.job_id !== move.job_id &&
      j.assigned_technician_id === move.technician_id &&
      j.status !== "completed" &&
      j.status !== "disrupted" &&
      Math.abs(hoursBetween(j.scheduled_time, move.to_time)) < 1.5 &&
      isFrozen(j.freeze_point, now),
  );
  if (collision) return false;

  const movedJob = ctx.getJob(move.job_id);
  return !movedJob || !isFrozen(movedJob.freeze_point, now);
}

// ── Deterministic candidate search (rule-based, no LLM) ───────────────

export interface CandidateMove {
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
  heuristic_cost: number;
}

/** Cheap, shared cost formula: lower is better. Reused by the mechanical
 * pre-filter, the LLM's stated priority order, and stubDisruption(). */
export function heuristicCost(t: CandidateMove["trade_offs"]): number {
  return (
    t.frozen_jobs_touched * 1000 + // should never be >0 post-filter; huge penalty if it ever is
    t.sla_breaches * 40 +
    t.customers_affected * 10 +
    t.total_added_travel_km
  );
}

/**
 * Real search over technicians × candidate time slots for the bumped job.
 * Every (technician, slot) pair is hard-filtered (skill, freeze, clash,
 * working hours) BEFORE a candidate is created — nothing illegal ever
 * enters the returned pool.
 */
function buildCandidateMoves(
  ctx: AgentContext,
  args: { bumped: Job; originalTechId: string; now: string },
): CandidateMove[] {
  const { bumped, originalTechId, now } = args;
  const out: CandidateMove[] = [];

  const skilledTechs = ctx.technicians.filter((t) =>
    bumped.skill_required.every((s) => t.skill_tags.includes(s)),
  );

  const seenSlots = new Set<string>();

  for (const t of skilledTechs) {
    for (const offset of SLOT_OFFSETS_HOURS) {
      const rawSlot = addHours(bumped.scheduled_time, offset);
      const slot = snapToServiceHours(rawSlot, 0);
      const dedupeKey = `${t.technician_id}|${slot}`;
      if (seenSlots.has(dedupeKey)) continue;
      seenSlots.add(dedupeKey);

      // Skip the no-op (same tech, same slot it's already in).
      if (t.technician_id === originalTechId && slot === bumped.scheduled_time) continue;

      const move = {
        job_id: bumped.job_id,
        customer_name: bumped.customer_name,
        from_time: bumped.scheduled_time,
        to_time: slot,
        technician_id: t.technician_id,
      };

      if (!moveIsFreezeSafe(ctx, move, now)) continue;
      const clash = findTimeClash(ctx.jobs, t.technician_id, slot, bumped.job_id);
      if (clash) continue;
      if (!isWithinWorkingHours(t.working_hours, slot)) continue;

      const isSameTech = t.technician_id === originalTechId;
      const trade_offs = tradeOffs(ctx, {
        bumped,
        newTime: slot,
        reassignTechId: isSameTech ? null : t.technician_id,
        now,
      });

      out.push({
        option_id: `opt_${isSameTech ? "delay" : "reassign"}_${t.technician_id}_${offset}h`,
        label: isSameTech
          ? `Delay ${offset}h (same technician)`
          : `Reassign to ${t.name}, ${offset}h slot`,
        moves: [move],
        trade_offs,
        heuristic_cost: heuristicCost(trade_offs),
      });
    }
  }

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
    // Always 0 here — moveIsFreezeSafe already excluded unsafe candidates
    // from the pool. Field kept for schema stability and because
    // heuristicCost still weights it defensively.
    frozen_jobs_touched: isFrozen(bumped.freeze_point, now) ? 1 : 0,
  };
}

/** Deterministic fallback summary when the LLM's summary isn't usable. */
export function summariseOption(c: { trade_offs: CandidateMove["trade_offs"]; moves: unknown[] }): string {
  const t = c.trade_offs;
  return (
    `${c.moves.length} job moved · ${t.customers_affected} customer(s) affected · ` +
    `+${t.total_added_travel_km} km travel · ` +
    `${t.sla_breaches} SLA breach(es) · ${t.frozen_jobs_touched} frozen job(s) touched`
  );
}

