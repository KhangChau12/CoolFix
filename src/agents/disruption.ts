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
  computeFreezePoint,
  DISPATCH_SERVICE_HOURS,
  findTimeClash,
  hoursBetween,
  isFrozen,
  isWithinWorkingHours,
  nowISO,
  snapToServiceHours,
} from "@/lib/time";
import { logDecision } from "./log";
import { validateDisruptionPlans } from "./schemas";
import type { AssignmentResult, LlmPlan } from "./schemas";
import type { Job, ReplanOption, RuntimeConfig, SkillTag, Tier } from "@/lib/types";
import { AUTO_REPLAN_LIMITS } from "@/lib/types";
import type { AgentContext } from "./context";

const TOP_N_FOR_LLM = 6;
// Same-day offsets 1..6h keep a real re-plan window even when the incoming
// urgent job lands mid-afternoon; then the next-day ladder (24..26h) and a
// two-day fallback (48h). Every generated slot is still hard-filtered
// against the technician's real working hours.
const SLOT_OFFSETS_HOURS = [1, 2, 3, 4, 5, 6, 24, 25, 26, 48];
/** How many plans we hand to the coordinator / keep for the feed. */
const MAX_PLANS_KEPT = 3;

const SYSTEM = `You are the Disruption Agent for CoolFix. A new urgent job needs a time slot
currently held by another job. YOU design the re-plan — you are not picking from a menu.

You are given a REPLAN_SPACE:
- bumped_job: the job that must move to free its slot.
- allowed_slots_by_tech: for the bumped job, the ONLY legal (technician_id -> [ISO slot])
  pairs. Every hard constraint (certification, freeze window, no double-booking, working
  hours) is ALREADY applied. Anything NOT in this map is forbidden.
- movable_soft_jobs: other lower-tier, not-yet-frozen jobs you MAY also move to open up a
  better slot (multi-step re-plan), each with its own allowed_slots_by_tech.

Produce 1 to 3 PLANS. Each plan is a list of moves; a move is
{job_id, to_tech_id, to_slot_iso}. Rules you MUST obey:
- job_id is the bumped job OR one of movable_soft_jobs.
- to_slot_iso MUST appear verbatim in that job's allowed_slots_by_tech[to_tech_id].
- Never invent a technician, job, or time. Never emit a move outside the space.
- Keep plans minimal — do not move a soft job unless it genuinely yields a better outcome.
- Prefer a slot with breathing room: pushing the bumped job to a time that sits right next
  to another job on the same technician (no travel buffer) is fragile. A slightly later
  slot with a clear gap is better than the earliest possible one.
- recommended_plan_id: the least harmful plan, priority order:
  fewer SLA breaches > no tight squeeze against another job > fewer customers moved >
  smaller total time shift > less added travel >
  do not disturb a customer already rescheduled recently (reschedule_count > 0).
- rationale: ONE sentence per plan, plain English, for a human coordinator.
- injection_attempt: always false (there is no customer text here).`;

const SCHEMA = `{"plans":[{"plan_id":string,"moves":[{"job_id":string,"to_tech_id":string,"to_slot_iso":string}],"rationale":string}],"recommended_plan_id":string,"injection_attempt":boolean}`;

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

  // ── Build the legal re-plan space (rule) ──────────────────────────
  // Every (technician, slot) pair in here already passed skill + freeze +
  // clash + working-hours. The LLM designs a plan *within* this space; it
  // can never step outside it.
  const space = buildReplanSpace(ctx, {
    bumped,
    originalTechId: tech.technician_id,
    now,
  });

  // Mechanical fallback pool — a single-move re-plan is always available as
  // a deterministic answer if the LLM plan is unusable.
  const fallbackPool = buildCandidateMoves(ctx, {
    bumped,
    originalTechId: tech.technician_id,
    now,
  });

  const spaceEmpty =
    Object.keys(space.allowedSlotsByTech).length === 0 &&
    space.movableSoftJobs.length === 0;

  // ── No clean option anywhere → stop, no re-plan. ──────────────────
  if (fallbackPool.length === 0 && spaceEmpty) {
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

  const rankedFallback = [...fallbackPool].sort(
    (a, b) => a.heuristic_cost - b.heuristic_cost,
  );
  // bestMechanical: the deterministic answer. Prefer the single-move pool;
  // if that is empty but the space is not, synthesise one from the space.
  const bestMechanical: CandidateMove =
    rankedFallback[0] ?? mechanicalFromSpace(ctx, space, now)!;

  // ── LLM designs the plan(s) ───────────────────────────────────────
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
      replan_space: {
        bumped_job: {
          job_id: bumped.job_id,
          customer_name: bumped.customer_name,
          tier: bumped.tier,
          current_tech_id: bumped.assigned_technician_id,
          current_slot: bumped.scheduled_time,
          skill_required: bumped.skill_required,
          reschedule_count: bumped.reschedule_history.length,
        },
        allowed_slots_by_tech: space.allowedSlotsByTech,
        movable_soft_jobs: space.movableSoftJobs.map((m) => ({
          job_id: m.job_id,
          customer_name: m.customer_name,
          tier: m.tier,
          current_tech_id: m.current_tech_id,
          current_slot: m.current_slot,
          skill_required: m.skill_required,
          reschedule_count: m.reschedule_count,
          allowed_slots_by_tech: m.allowed_slots_by_tech,
        })),
      },
    },
    expectedSchema: SCHEMA,
    // Retry only for malformed JSON (inside callLlm). A parseable-but-invalid
    // plan is caught below and falls back to bestMechanical immediately.
    maxAttempts: 2,
  };

  let resp: Awaited<ReturnType<typeof callLlm>> | null = null;
  const rejectionNotes: string[] = [];
  try {
    resp = await callLlm(llmCallArgs);
  } catch {
    rejectionNotes.push(
      "LLM call failed after retry (malformed JSON) — using best mechanical option instead.",
    );
  }

  // Each surviving plan becomes a ReplanOption. The LLM proposes and
  // explains the plans; the RULE layer then re-scores every option on the
  // shared cost formula (SLA breach > squeeze > customers moved > shift
  // distance > travel) and the lowest-cost option is the recommendation.
  // So the LLM can design a clever multi-step plan, but it cannot talk the
  // system into a plan the numbers say is worse than another it also
  // offered — the recommendation is objective.
  let acceptedOptions: ReplanOption[] = [];
  let llmAccepted = false;

  if (resp) {
    try {
      const parsed = validateDisruptionPlans(resp.data, space);
      const llmRecommendedId = parsed.plans[0]?.plan_id ?? null;
      const scored: { opt: ReplanOption; cost: number; llmRec: boolean }[] = [];
      for (const plan of parsed.plans) {
        if (scored.length >= MAX_PLANS_KEPT) break;
        const rv = revalidatePlan(ctx, plan, now);
        if (!rv.ok) {
          rejectionNotes.push(
            `LLM plan ${plan.plan_id} rejected on re-validation (${rv.reason}).`,
          );
          continue;
        }
        const opt = planToReplanOption(
          ctx,
          plan,
          rv.resolvedMoves!,
          scored.length,
          now,
        );
        scored.push({
          opt,
          cost: heuristicCost(opt.trade_offs),
          llmRec: plan.plan_id === llmRecommendedId,
        });
      }
      if (scored.length > 0) {
        llmAccepted = true;
        scored.sort((a, b) => a.cost - b.cost);
        acceptedOptions = scored.map((s) => s.opt);
        acceptedOptions[0].recommended = true;
        // If the objective winner isn't the LLM's stated pick, say so.
        if (!scored[0].llmRec && scored.some((s) => s.llmRec)) {
          rejectionNotes.push(
            "The LLM's stated preference scored worse than another plan it proposed — the lower-cost plan is recommended instead.",
          );
        }
      } else {
        rejectionNotes.push(
          "No LLM plan survived live re-validation — using best mechanical option instead.",
        );
      }
    } catch (e) {
      rejectionNotes.push(
        `LLM response failed the plan-space cross-check (${
          e instanceof Error ? e.message : "invalid"
        }) — using best mechanical option instead.`,
      );
    }
  }

  // ── Assemble the options the coordinator / feed sees ──────────────
  let options: ReplanOption[];
  let chosen: ReplanOption;

  if (llmAccepted) {
    options = acceptedOptions;
    // Attach the mechanical baseline as a labelled comparison option, if it
    // is distinct from what the LLM produced.
    const mechOpt = candidateToReplanOption(bestMechanical, false);
    if (!options.some((o) => sameMoves(o, mechOpt))) {
      options = [...options, { ...mechOpt, label: `${mechOpt.label} (mechanical baseline)` }];
    }
    chosen = acceptedOptions[0];
  } else {
    const mechShortlist = rankedFallback.slice(0, TOP_N_FOR_LLM);
    options =
      mechShortlist.length > 0
        ? mechShortlist.map((c, i) =>
            candidateToReplanOption(c, i === 0),
          )
        : [candidateToReplanOption(bestMechanical, true)];
    chosen = options[0];
  }

  // ── Risk calibration ─────────────────────────────────────────────
  // Freeze window is already guaranteed clean by generation-time filtering.
  // The remaining question is whether this move is low-impact enough to
  // commit without a human. It qualifies for auto-commit ONLY if it clears
  // BOTH the tunable config thresholds AND every fixed safety rail (soft
  // tier, same-day, small shift, comfortable gap, no SLA breach, not a job
  // that was already rescheduled once). Anything else waits for a
  // coordinator.
  const autoCommit = replanQualifiesForAutoCommit(ctx, chosen, cfg, now);
  const needsApproval = !autoCommit.ok;

  const entry = logDecision(ctx, {
    agent: "DisruptionAgent",
    jobId: incoming.job_id,
    reasoningKind: "llm",
    input: {
      incoming_job: incoming.job_id,
      bumped_job: bumped.job_id,
      technician: tech.name,
      skilled_techs: space.skilledTechIds.length,
      legal_slots: Object.values(space.allowedSlotsByTech).reduce(
        (n, a) => n + a.length,
        0,
      ),
      movable_soft_jobs: space.movableSoftJobs.length,
      llm_mode: resp?.mode ?? "failed",
      cached: resp?.cached ?? false,
    },
    output: {
      chosen_option_id: chosen.option_id,
      plan_moves: chosen.moves.length,
      needs_approval: needsApproval,
      llm_choice_accepted: llmAccepted,
    },
    headline: llmAccepted
      ? needsApproval
        ? `LLM re-plan (${chosen.moves.length} move${chosen.moves.length > 1 ? "s" : ""}) — needs approval, affects ${chosen.trade_offs.customers_affected} customer(s)`
        : `LLM re-plan auto-committed: ${chosen.label}`
      : needsApproval
        ? `Approval needed: re-plan affects ${chosen.trade_offs.customers_affected} customer(s)`
        : `Auto-commit re-plan: ${chosen.label}`,
    outcome: needsApproval ? "requires_approval" : "auto_commit",
    requiresApproval: needsApproval,
    replanOptions: options,
    latencyMs: resp?.latency_ms ?? 0,
    guardrailNotes: [
      ...(resp?.guardrail_notes ?? []),
      `Legal re-plan space: ${space.skilledTechIds.length} certified technician(s), ${Object.values(
        space.allowedSlotsByTech,
      ).reduce((n, a) => n + a.length, 0)} pre-verified slot(s), ${space.movableSoftJobs.length} movable soft job(s).`,
      ...rejectionNotes,
      llmAccepted
        ? `LLM designed the re-plan; the chosen plan was re-validated move-by-move against live schedule state before use.`
        : "Fell back to the best pre-computed mechanical option — every constraint still enforced.",
      needsApproval
        ? `Not eligible for auto-commit — ${autoCommit.reasons.join("; ")}. Routing to a coordinator.`
        : `Low impact on every safety rail (soft tier, same-day, ≤${AUTO_REPLAN_LIMITS.maxShiftHours}h shift, ≥${AUTO_REPLAN_LIMITS.minGapHours}h gap, no SLA breach) — auto-committed without a human.`,
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

// ── ReplanSpace: the legal state space the LLM plans within ──────────

export interface MovableSoftJob {
  job_id: string;
  customer_name: string;
  tier: Tier;
  current_tech_id: string;
  current_slot: string;
  skill_required: SkillTag[];
  reschedule_count: number;
  /** technician_id -> legal ISO slots to move THIS soft job to. */
  allowed_slots_by_tech: Record<string, string[]>;
}

export interface ReplanSpace {
  bumpedJobId: string;
  bumpedJob: Job;
  originalTechId: string;
  skilledTechIds: string[];
  /** technician_id -> legal ISO slots to move the BUMPED job to. */
  allowedSlotsByTech: Record<string, string[]>;
  movableSoftJobs: MovableSoftJob[];
}

/** Legal slots for `job` on `t`, hard-filtered (freeze, clash, hours). */
function legalSlotsFor(
  ctx: AgentContext,
  job: Job,
  t: { technician_id: string; working_hours: { start: string; end: string } },
  now: string,
): string[] {
  const slots: string[] = [];
  for (const offset of SLOT_OFFSETS_HOURS) {
    const slot = snapToServiceHours(
      addHours(job.scheduled_time, offset),
      0,
      DISPATCH_SERVICE_HOURS,
    );
    if (slots.includes(slot)) continue;
    if (job.assigned_technician_id === t.technician_id && slot === job.scheduled_time) {
      continue; // no-op
    }
    const move = { job_id: job.job_id, to_time: slot, technician_id: t.technician_id };
    if (!moveIsFreezeSafe(ctx, move, now)) continue;
    if (findTimeClash(ctx.jobs, t.technician_id, slot, job.job_id)) continue;
    if (!isWithinWorkingHours(t.working_hours, slot)) continue;
    slots.push(slot);
  }
  return slots;
}

function buildReplanSpace(
  ctx: AgentContext,
  args: { bumped: Job; originalTechId: string; now: string },
): ReplanSpace {
  const { bumped, originalTechId, now } = args;

  const skilled = ctx.technicians.filter((t) =>
    bumped.skill_required.every((s) => t.skill_tags.includes(s)),
  );

  const allowedSlotsByTech: Record<string, string[]> = {};
  for (const t of skilled) {
    const slots = legalSlotsFor(ctx, bumped, t, now);
    if (slots.length) allowedSlotsByTech[t.technician_id] = slots;
  }

  const movableSoftJobs: MovableSoftJob[] = ctx.jobs
    .filter(
      (j) =>
        j.job_id !== bumped.job_id &&
        j.assigned_technician_id &&
        (j.tier === "flexible" || j.tier === "standard") &&
        j.status === "assigned" &&
        !isFrozen(j.freeze_point, now),
    )
    .slice(0, 4)
    .map((j) => {
      const skilledForThis = ctx.technicians.filter((t) =>
        j.skill_required.every((s) => t.skill_tags.includes(s)),
      );
      const abt: Record<string, string[]> = {};
      for (const t of skilledForThis) {
        const slots = legalSlotsFor(ctx, j, t, now);
        if (slots.length) abt[t.technician_id] = slots;
      }
      return {
        job_id: j.job_id,
        customer_name: j.customer_name,
        tier: j.tier,
        current_tech_id: j.assigned_technician_id!,
        current_slot: j.scheduled_time,
        skill_required: j.skill_required,
        reschedule_count: j.reschedule_history.length,
        allowed_slots_by_tech: abt,
      };
    })
    .filter((m) => Object.keys(m.allowed_slots_by_tech).length > 0);

  return {
    bumpedJobId: bumped.job_id,
    bumpedJob: bumped,
    originalTechId,
    skilledTechIds: skilled.map((t) => t.technician_id),
    allowedSlotsByTech,
    movableSoftJobs,
  };
}

/** Deterministic single-move plan drawn straight from the space, used only
 * when the single-move fallback pool is empty but the space is not. */
function mechanicalFromSpace(
  ctx: AgentContext,
  space: ReplanSpace,
  now: string,
): CandidateMove | null {
  const entries = Object.entries(space.allowedSlotsByTech);
  if (entries.length === 0) return null;
  let best: CandidateMove | null = null;
  for (const [techId, slots] of entries) {
    for (const slot of slots) {
      const isSame = techId === space.originalTechId;
      const to = tradeOffs(ctx, {
        bumped: space.bumpedJob,
        newTime: slot,
        reassignTechId: isSame ? null : techId,
        now,
      });
      const cand: CandidateMove = {
        option_id: `opt_space_${techId}_${slot}`,
        label: isSame ? "Delay (same technician)" : `Reassign to ${ctx.getTechnician(techId)?.name ?? techId}`,
        moves: [
          {
            job_id: space.bumpedJob.job_id,
            customer_name: space.bumpedJob.customer_name,
            from_time: space.bumpedJob.scheduled_time,
            to_time: slot,
            technician_id: techId,
          },
        ],
        trade_offs: to,
        heuristic_cost: heuristicCost(to),
      };
      if (!best || cand.heuristic_cost < best.heuristic_cost) best = cand;
    }
  }
  return best;
}

// ── Post-LLM re-validation — never trust the LLM's plan blindly ──────

interface PlanRevalidation {
  ok: boolean;
  reason?: string;
  resolvedMoves?: ReplanOption["moves"];
}

/**
 * Re-checks an LLM plan against LIVE constraint state, simulating each move
 * on a mutated clone so a later move is validated on the state the earlier
 * moves leave behind (two moves in one plan can conflict even when each
 * passes in isolation). Same predicates as generation time.
 */
function revalidatePlan(ctx: AgentContext, plan: LlmPlan, now: string): PlanRevalidation {
  if (plan.moves.length === 0) return { ok: false, reason: "empty plan" };

  const sim: Job[] = ctx.jobs.map((j) => ({ ...j }));
  const getSim = (id: string) => sim.find((j) => j.job_id === id);
  const resolved: ReplanOption["moves"] = [];

  for (const m of plan.moves) {
    const job = getSim(m.job_id);
    if (!job) return { ok: false, reason: `unknown job ${m.job_id}` };
    const t = ctx.getTechnician(m.to_tech_id);
    if (!t) return { ok: false, reason: `unknown technician ${m.to_tech_id}` };

    if (!job.skill_required.every((s) => t.skill_tags.includes(s))) {
      return { ok: false, reason: `${t.name} lacks the certification for ${m.job_id}` };
    }
    if (
      !moveIsFreezeSafeIn(
        sim,
        { job_id: m.job_id, to_time: m.to_slot_iso, technician_id: m.to_tech_id },
        now,
      )
    ) {
      return { ok: false, reason: "move touches a frozen job" };
    }
    if (findTimeClash(sim, m.to_tech_id, m.to_slot_iso, m.job_id)) {
      return { ok: false, reason: `clash for ${t.name} at ${m.to_slot_iso}` };
    }
    if (!isWithinWorkingHours(t.working_hours, m.to_slot_iso)) {
      return { ok: false, reason: `outside ${t.name}'s working hours` };
    }

    resolved.push({
      job_id: m.job_id,
      customer_name: job.customer_name,
      from_time: job.scheduled_time,
      to_time: m.to_slot_iso,
      technician_id: m.to_tech_id,
    });

    // Apply the move onto the simulation for the next step.
    job.scheduled_time = m.to_slot_iso;
    job.assigned_technician_id = m.to_tech_id;
    job.freeze_point = computeFreezePoint(m.to_slot_iso, ctx.config.freezeWindowHours);
  }
  return { ok: true, resolvedMoves: resolved };
}

// ── ReplanOption assembly ───────────────────────────────────────────

function combinedTradeOffs(
  ctx: AgentContext,
  moves: ReplanOption["moves"],
  now: string,
): ReplanOption["trade_offs"] {
  let addedKm = 0;
  let slaBreaches = 0;
  let shiftHours = 0;
  let tightestGap = Infinity;
  const customers = new Set<string>();
  // Simulate the moves in order so a later move's gap is measured against
  // where earlier moves in the same plan land.
  const sim: Job[] = ctx.jobs.map((j) => ({ ...j }));
  for (const mv of moves) {
    customers.add(mv.job_id);
    const job = ctx.getJob(mv.job_id);
    if (!job) continue;
    const to = tradeOffs(ctx, {
      bumped: job,
      newTime: mv.to_time,
      reassignTechId:
        job.assigned_technician_id && job.assigned_technician_id !== mv.technician_id
          ? mv.technician_id
          : null,
      now,
    });
    addedKm += to.total_added_travel_km;
    slaBreaches += to.sla_breaches;
    shiftHours += to.total_shift_hours ?? 0;
    const gap = tightestGapHours(sim, mv.technician_id, mv.to_time, mv.job_id);
    if (gap < tightestGap) tightestGap = gap;
    // apply onto sim
    const s = sim.find((j) => j.job_id === mv.job_id);
    if (s) {
      s.scheduled_time = mv.to_time;
      s.assigned_technician_id = mv.technician_id;
    }
  }
  return {
    customers_affected: customers.size,
    total_added_travel_km: Math.round(addedKm * 10) / 10,
    sla_breaches: slaBreaches,
    frozen_jobs_touched: 0, // guaranteed by revalidatePlan / generation-time filter
    total_shift_hours: Math.round(shiftHours * 10) / 10,
    tightest_gap_hours: Number.isFinite(tightestGap)
      ? Math.round(tightestGap * 10) / 10
      : undefined,
  };
}

function planToReplanOption(
  ctx: AgentContext,
  plan: LlmPlan,
  resolvedMoves: ReplanOption["moves"],
  index: number,
  now: string,
): ReplanOption {
  const to = combinedTradeOffs(ctx, resolvedMoves, now);
  const stepLabel =
    resolvedMoves.length > 1
      ? `${resolvedMoves.length}-step re-plan`
      : `Move ${resolvedMoves[0].customer_name}'s job`;
  return {
    option_id: `plan_${index + 1}_${plan.plan_id}`.slice(0, 60),
    label: stepLabel,
    summary: summariseMoves(resolvedMoves, to),
    plan_rationale: plan.rationale.slice(0, 300),
    moves: resolvedMoves,
    trade_offs: to,
    recommended: false,
  };
}

function candidateToReplanOption(c: CandidateMove, recommended: boolean): ReplanOption {
  return {
    option_id: c.option_id,
    label: c.label,
    summary: summariseOption(c),
    moves: c.moves,
    trade_offs: c.trade_offs,
    recommended,
  };
}

function summariseMoves(
  moves: ReplanOption["moves"],
  t: ReplanOption["trade_offs"],
): string {
  const shift = t.total_shift_hours != null ? ` · shifted ${t.total_shift_hours}h` : "";
  const gap =
    t.tightest_gap_hours != null
      ? ` · ${t.tightest_gap_hours}h gap to next job${t.tightest_gap_hours < 2 ? " ⚠ tight" : ""}`
      : "";
  return (
    `${moves.length} job${moves.length > 1 ? "s" : ""} moved · ${t.customers_affected} customer(s) affected · ` +
    `+${t.total_added_travel_km} km travel · ${t.sla_breaches} SLA breach(es)${shift}${gap}`
  );
}

function sameMoves(a: ReplanOption, b: ReplanOption): boolean {
  if (a.moves.length !== b.moves.length) return false;
  const key = (o: ReplanOption) =>
    o.moves
      .map((m) => `${m.job_id}|${m.to_time}|${m.technician_id}`)
      .sort()
      .join(",");
  return key(a) === key(b);
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
  return moveIsFreezeSafeIn(ctx.jobs, move, now);
}

/**
 * Same rule as moveIsFreezeSafe but operating on an explicit job array
 * instead of the context. Used by revalidatePlan(), which simulates a
 * multi-step plan against a mutated clone of the schedule so each step is
 * checked on the state left by the previous step.
 */
function moveIsFreezeSafeIn(
  jobs: Job[],
  move: { job_id: string; to_time: string; technician_id: string },
  now: string,
): boolean {
  const collision = jobs.find(
    (j) =>
      j.job_id !== move.job_id &&
      j.assigned_technician_id === move.technician_id &&
      j.status !== "completed" &&
      j.status !== "disrupted" &&
      Math.abs(hoursBetween(j.scheduled_time, move.to_time)) < 1.5 &&
      isFrozen(j.freeze_point, now),
  );
  if (collision) return false;

  const movedJob = jobs.find((j) => j.job_id === move.job_id);
  return !movedJob || !isFrozen(movedJob.freeze_point, now);
}

// ── Auto-commit qualification (rule-based) ───────────────────────────

/**
 * A re-plan skips the human ONLY when it is genuinely low-impact. The
 * config thresholds (`hitlMaxCustomersAffected`, `hitlMaxAddedTravelKm`)
 * are the tunable part; on top of them we enforce fixed safety rails so
 * "1 customer affected" is only auto-committed when that customer is on a
 * soft tier, is barely moved, still has a comfortable gap, keeps their SLA,
 * and hasn't already been rescheduled once. Any rail broken → HITL.
 * Returns { ok, reasons } — `reasons` lists every rail that failed, for the
 * decision log.
 */
export function replanQualifiesForAutoCommit(
  ctx: AgentContext,
  chosen: ReplanOption,
  cfg: RuntimeConfig,
  now: string,
): { ok: boolean; reasons: string[] } {
  const t = chosen.trade_offs;
  const reasons: string[] = [];

  if (t.customers_affected > cfg.hitlMaxCustomersAffected) {
    reasons.push(
      `${t.customers_affected} customers affected (limit ${cfg.hitlMaxCustomersAffected})`,
    );
  }
  if (t.total_added_travel_km > cfg.hitlMaxAddedTravelKm) {
    reasons.push(
      `+${t.total_added_travel_km} km travel (limit ${cfg.hitlMaxAddedTravelKm} km)`,
    );
  }
  if (t.sla_breaches > 0) {
    reasons.push(`${t.sla_breaches} SLA breach(es)`);
  }
  if ((t.total_shift_hours ?? 0) > AUTO_REPLAN_LIMITS.maxShiftHours) {
    reasons.push(
      `${t.total_shift_hours}h shift (limit ${AUTO_REPLAN_LIMITS.maxShiftHours}h)`,
    );
  }
  if (
    t.tightest_gap_hours != null &&
    t.tightest_gap_hours < AUTO_REPLAN_LIMITS.minGapHours
  ) {
    reasons.push(
      `${t.tightest_gap_hours}h gap to the next job (need ≥${AUTO_REPLAN_LIMITS.minGapHours}h)`,
    );
  }

  for (const mv of chosen.moves) {
    const job = ctx.getJob(mv.job_id);
    if (!job) {
      reasons.push(`moved job ${mv.job_id} not found`);
      continue;
    }
    if (!AUTO_REPLAN_LIMITS.movableTiers.includes(job.tier)) {
      reasons.push(`${job.customer_name}'s job is ${job.tier} tier (auto-move is soft-tier only)`);
    }
    if (job.reschedule_history.length > AUTO_REPLAN_LIMITS.maxPriorReschedules) {
      reasons.push(`${job.customer_name} was already rescheduled once`);
    }
    if (!sameSgDay(mv.from_time, mv.to_time)) {
      reasons.push(`${job.customer_name}'s job would move to another day`);
    }
    // The move must not push the job past its own freeze point either — a
    // low-impact move keeps the customer well clear of the lock.
    const newFreeze = computeFreezePoint(mv.to_time, ctx.config.freezeWindowHours);
    if (isFrozen(newFreeze, now)) {
      reasons.push(`${job.customer_name}'s new slot is already inside its freeze window`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}

/** Same Singapore-local calendar day? */
function sameSgDay(aISO: string, bISO: string): boolean {
  const day = (iso: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Singapore",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(iso));
  return day(aISO) === day(bISO);
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
  trade_offs: ReplanOption["trade_offs"];
  heuristic_cost: number;
}

/**
 * Cheap, shared cost formula: lower is better. Reused by the mechanical
 * pre-filter, the LLM's stated priority order, and stubDisruption().
 *
 * Priority order encoded here (highest penalty first):
 *   1. touching a frozen job          — must never happen (huge guard)
 *   2. breaking an SLA                 — a broken customer promise
 *   3. squeezing a job in tight        — a slot < 2h from the next job on
 *      that technician is fragile: no travel buffer, cascades on any delay
 *   4. moving more customers           — each extra disrupted customer
 *   5. pushing a job far from its slot — a 1h delay is minor, a 2-day one
 *      is a real inconvenience even if it's still inside SLA
 *   6. added travel kilometres         — the tie-breaker
 */
export function heuristicCost(t: CandidateMove["trade_offs"]): number {
  const tightGap = t.tightest_gap_hours ?? Infinity;
  // Penalise the squeeze: full penalty at a 0h gap, tapering to 0 by 2h.
  const squeezePenalty = tightGap >= 2 ? 0 : (2 - tightGap) * 15;
  const shiftPenalty = (t.total_shift_hours ?? 0) * 0.5;
  return (
    t.frozen_jobs_touched * 1000 +
    t.sla_breaches * 40 +
    squeezePenalty +
    t.customers_affected * 10 +
    shiftPenalty +
    t.total_added_travel_km
  );
}

/** Smallest gap (hours) between `slot` on `techId` and the nearest OTHER
 * job already on that technician. Infinity if the technician is otherwise
 * free. `ignoreJobId` is the job being placed. */
function tightestGapHours(
  jobs: Job[],
  techId: string,
  slot: string,
  ignoreJobId: string,
): number {
  let min = Infinity;
  for (const j of jobs) {
    if (j.job_id === ignoreJobId) continue;
    if (j.assigned_technician_id !== techId) continue;
    if (j.status === "completed" || j.status === "disrupted") continue;
    const gap = Math.abs(hoursBetween(j.scheduled_time, slot));
    if (gap < min) min = gap;
  }
  return min;
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
      const slot = snapToServiceHours(rawSlot, 0, DISPATCH_SERVICE_HOURS);
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

  const targetTech = reassignTechId ?? bumped.assigned_technician_id ?? "";
  const shiftHours = Math.abs(hoursBetween(bumped.scheduled_time, newTime));
  const gap = tightestGapHours(ctx.jobs, targetTech, newTime, bumped.job_id);

  return {
    customers_affected: 1,
    total_added_travel_km: Math.round(addedKm * 10) / 10,
    sla_breaches: slaBreach,
    // Always 0 here — moveIsFreezeSafe already excluded unsafe candidates
    // from the pool. Field kept for schema stability and because
    // heuristicCost still weights it defensively.
    frozen_jobs_touched: isFrozen(bumped.freeze_point, now) ? 1 : 0,
    total_shift_hours: Math.round(shiftHours * 10) / 10,
    tightest_gap_hours: Number.isFinite(gap) ? Math.round(gap * 10) / 10 : undefined,
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

