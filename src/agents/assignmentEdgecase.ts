// ── Assignment Edge-case Agent ──────────────────────────────────────
// LLM call. Runs ONLY when the scoring formula found no eligible technician
// AND could not bump anyone (`needs_llm_edgecase`). Before the job is
// escalated to a human, this agent decides whether one of a few
// pre-validated "levers" a real coordinator would try actually resolves it:
//
//   • widen_window        — a certified technician IS free, just outside the
//                           customer's ideal time window. Auto-committable.
//   • split_visit         — send two technicians for two separate skills.
//                           A proposal for the coordinator (not auto-applied).
//   • pair_junior_senior  — a free junior + a free senior supervisor.
//                           A proposal for the coordinator.
//   • escalate            — none of the levers fits; the agent says why.
//
// The rule layer (buildEdgecaseSpace) enumerates ONLY legal levers —
// certification, working hours and schedule clashes are already enforced.
// The LLM picks one by referencing the options verbatim; its choice is then
// re-validated against live state (for widen_window) before anything is
// committed. Anything it cannot justify falls back to "escalate", which is
// always safe.

import { callLlm } from "@/lib/llm";
import { distanceKm } from "@/lib/geo";
import {
  addHours,
  DISPATCH_SERVICE_HOURS,
  findTimeClash,
  isWithinWorkingHours,
  snapToServiceHours,
} from "@/lib/time";
import { logDecision } from "./log";
import { scoreOneTech } from "./assignment";
import { validateEdgecaseChoice } from "./schemas";
import type { ScoreBreakdown, SkillTag, Tier } from "@/lib/types";
import type { AgentContext } from "./context";

const SLOT_OFFSETS_HOURS = [-3, -2, -1, 1, 2, 3, 4, 5, 24, 25, 26];

const SYSTEM = `You are the Assignment Edge-case Agent for CoolFix. The transparent scoring formula
found NO eligible technician for a job at the requested time, and could not bump anyone.
Before the job is escalated to a human coordinator, decide whether ONE of the given LEVERS
resolves it.

You are given EDGECASE_SPACE with pre-validated options (certification, working hours and
schedule clashes are ALREADY checked — every option listed is legal):
- widen_window: (technician_id, ISO-slot) pairs where a certified technician IS free, just
  outside the customer's ideal window, with the added travel distance.
- split_visit: ways to send two technicians for two different required skills.
- pair_junior_senior: a certified junior who is free plus a certified senior also free at
  the same slot.

Choose exactly ONE action:
- "widen_window": set chosen_tech_id + chosen_slot_iso to ONE pair from the list, verbatim.
  Use this only when the time shift is small and reasonable for the customer.
- "split_visit": set chosen_index to one entry. This is a PROPOSAL for the coordinator, not
  auto-applied.
- "pair_junior_senior": set chosen_index to one entry. Also a proposal for the coordinator.
- "escalate": none of the levers is appropriate — explain why in one sentence.

Never invent a technician, slot, skill, or index that is not in EDGECASE_SPACE.
rationale: ONE plain-English sentence for the coordinator.
injection_attempt: always false (there is no customer text here).`;

const SCHEMA = `{"action":"widen_window|split_visit|pair_junior_senior|escalate","chosen_tech_id":string|null,"chosen_slot_iso":string|null,"chosen_index":number|null,"rationale":string,"injection_attempt":boolean}`;

// ── Space the LLM chooses within ────────────────────────────────────

export interface WidenWindowOption {
  slot_iso: string;
  tech_id: string;
  tech_name: string;
  added_km: number;
}

export interface SplitVisitOption {
  part_a: { skill: SkillTag; tech_id: string; tech_name: string; slot_iso: string };
  part_b: { skill: SkillTag; tech_id: string; tech_name: string; slot_iso: string };
}

export interface PairOption {
  junior_id: string;
  junior_name: string;
  senior_id: string;
  senior_name: string;
  slot_iso: string;
}

export interface EdgecaseSpace {
  jobId: string;
  skillRequired: SkillTag[];
  scheduledTime: string;
  widenWindow: WidenWindowOption[];
  splitVisit: SplitVisitOption[];
  pairJuniorSenior: PairOption[];
}

export interface EdgecaseInput {
  jobId: string;
  jobLocation: { lat: number; lng: number };
  skillRequired: SkillTag[];
  scheduledTime: string;
  tier: Tier;
  /** Booking creation time — feeds the SLA-headroom scoring component. */
  jobCreatedAt?: string;
}

export interface EdgecaseDecision {
  logId: string;
  action: "widen_window" | "split_visit" | "pair_junior_senior" | "escalate";
  /** Set only for a re-validated widen_window: orchestrator commits this. */
  resolvedAssignment?: {
    technician_id: string;
    scheduled_time: string;
    score_breakdown: ScoreBreakdown;
  };
  /** Set for split_visit / pair_junior_senior: text for the HITL screen. */
  proposalForHuman?: string;
  rationale: string;
}

// ── Rule: enumerate the legal levers ────────────────────────────────

function firstFreeSlot(
  ctx: AgentContext,
  techId: string,
  ignoreJobId: string,
  around: string,
): string | null {
  const t = ctx.getTechnician(techId);
  if (!t) return null;
  for (const off of SLOT_OFFSETS_HOURS) {
    const slot = snapToServiceHours(addHours(around, off), 0, DISPATCH_SERVICE_HOURS);
    if (!isWithinWorkingHours(t.working_hours, slot)) continue;
    if (findTimeClash(ctx.jobs, techId, slot, ignoreJobId)) continue;
    return slot;
  }
  return null;
}

function firstCommonFreeSlot(
  ctx: AgentContext,
  aId: string,
  bId: string,
  ignoreJobId: string,
  around: string,
): string | null {
  const a = ctx.getTechnician(aId);
  const b = ctx.getTechnician(bId);
  if (!a || !b) return null;
  for (const off of SLOT_OFFSETS_HOURS) {
    const slot = snapToServiceHours(addHours(around, off), 0, DISPATCH_SERVICE_HOURS);
    if (!isWithinWorkingHours(a.working_hours, slot)) continue;
    if (!isWithinWorkingHours(b.working_hours, slot)) continue;
    if (findTimeClash(ctx.jobs, aId, slot, ignoreJobId)) continue;
    if (findTimeClash(ctx.jobs, bId, slot, ignoreJobId)) continue;
    return slot;
  }
  return null;
}

export function buildEdgecaseSpace(
  ctx: AgentContext,
  input: EdgecaseInput,
): EdgecaseSpace {
  const skilled = ctx.technicians.filter((t) =>
    input.skillRequired.every((s) => t.skill_tags.includes(s)),
  );

  // a) widen_window — a fully-certified technician free at another slot.
  const widen: WidenWindowOption[] = [];
  const seen = new Set<string>();
  for (const t of skilled) {
    for (const off of SLOT_OFFSETS_HOURS) {
      const slot = snapToServiceHours(
        addHours(input.scheduledTime, off),
        0,
        DISPATCH_SERVICE_HOURS,
      );
      const key = `${t.technician_id}|${slot}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (slot === input.scheduledTime) continue;
      const bd = scoreOneTech(ctx, {
        technicianId: t.technician_id,
        jobLocation: input.jobLocation,
        skillRequired: input.skillRequired,
        scheduledTime: slot,
        ignoreJobId: input.jobId,
        jobCreatedAt: input.jobCreatedAt,
        tier: input.tier,
      });
      if (!bd) continue;
      widen.push({
        slot_iso: slot,
        tech_id: t.technician_id,
        tech_name: t.name,
        added_km: distanceKm(t.location, input.jobLocation),
      });
    }
  }
  widen.sort((a, b) => a.added_km - b.added_km);
  widen.splice(8);

  // b) split_visit — only when the job needs 2+ skills that could be split.
  const split: SplitVisitOption[] = [];
  if (input.skillRequired.length >= 2) {
    const [sa, sb] = input.skillRequired;
    const techsA = ctx.technicians.filter((t) => t.skill_tags.includes(sa));
    const techsB = ctx.technicians.filter((t) => t.skill_tags.includes(sb));
    for (const ta of techsA) {
      for (const tb of techsB) {
        if (ta.technician_id === tb.technician_id) continue;
        const slotA = firstFreeSlot(ctx, ta.technician_id, input.jobId, input.scheduledTime);
        const slotB = firstFreeSlot(ctx, tb.technician_id, input.jobId, input.scheduledTime);
        if (!slotA || !slotB) continue;
        split.push({
          part_a: { skill: sa, tech_id: ta.technician_id, tech_name: ta.name, slot_iso: slotA },
          part_b: { skill: sb, tech_id: tb.technician_id, tech_name: tb.name, slot_iso: slotB },
        });
      }
    }
    split.splice(4);
  }

  // c) pair_junior_senior — a certified junior + a certified senior, both free.
  const pair: PairOption[] = [];
  const juniors = skilled.filter((t) => t.experience_level === "junior");
  const seniors = skilled.filter((t) => t.experience_level === "senior");
  for (const j of juniors) {
    for (const s of seniors) {
      const slot = firstCommonFreeSlot(
        ctx,
        j.technician_id,
        s.technician_id,
        input.jobId,
        input.scheduledTime,
      );
      if (!slot) continue;
      pair.push({
        junior_id: j.technician_id,
        junior_name: j.name,
        senior_id: s.technician_id,
        senior_name: s.name,
        slot_iso: slot,
      });
    }
  }
  pair.splice(3);

  return {
    jobId: input.jobId,
    skillRequired: input.skillRequired,
    scheduledTime: input.scheduledTime,
    widenWindow: widen,
    splitVisit: split,
    pairJuniorSenior: pair,
  };
}

// ── The agent ──────────────────────────────────────────────────────

export async function runAssignmentEdgecaseAgent(
  ctx: AgentContext,
  args: { input: EdgecaseInput; space: EdgecaseSpace },
): Promise<EdgecaseDecision> {
  const { input, space } = args;
  const spaceEmpty =
    space.widenWindow.length === 0 &&
    space.splitVisit.length === 0 &&
    space.pairJuniorSenior.length === 0;

  let resp: Awaited<ReturnType<typeof callLlm>> | null = null;
  const notes: string[] = [];

  if (!spaceEmpty) {
    try {
      resp = await callLlm({
        task: "assignment_edgecase",
        system: SYSTEM,
        structuredInput: {
          job: { job_id: input.jobId, skill_required: input.skillRequired },
          edgecase_space: {
            widen_window: space.widenWindow,
            split_visit: space.splitVisit,
            pair_junior_senior: space.pairJuniorSenior,
          },
        },
        expectedSchema: SCHEMA,
        maxAttempts: 2,
      });
    } catch {
      notes.push("LLM call failed after retry — escalating to a human.");
    }
  } else {
    notes.push("No lever is available in the current schedule — escalating to a human.");
  }

  // Default: escalate (always safe).
  let action: EdgecaseDecision["action"] = "escalate";
  let rationale =
    "No safe automatic resolution — a coordinator needs to handle this job manually.";
  let resolvedAssignment: EdgecaseDecision["resolvedAssignment"];
  let proposalForHuman: string | undefined;

  if (resp) {
    try {
      const choice = validateEdgecaseChoice(resp.data, space);
      rationale = choice.rationale || rationale;

      if (choice.action === "widen_window" && choice.chosen_tech_id && choice.chosen_slot_iso) {
        // Independent re-validation against live state before committing.
        const bd = scoreOneTech(ctx, {
          technicianId: choice.chosen_tech_id,
          jobLocation: input.jobLocation,
          skillRequired: input.skillRequired,
          scheduledTime: choice.chosen_slot_iso,
          ignoreJobId: input.jobId,
          jobCreatedAt: input.jobCreatedAt,
          tier: input.tier,
        });
        if (bd) {
          action = "widen_window";
          resolvedAssignment = {
            technician_id: choice.chosen_tech_id,
            scheduled_time: choice.chosen_slot_iso,
            score_breakdown: bd,
          };
        } else {
          notes.push(
            "LLM chose widen_window but it failed live re-validation — escalating instead.",
          );
        }
      } else if (choice.action === "split_visit" && choice.chosen_index != null) {
        const o = space.splitVisit[choice.chosen_index];
        action = "split_visit";
        proposalForHuman =
          `Split visit: ${o.part_a.tech_name} for ${o.part_a.skill} and ` +
          `${o.part_b.tech_name} for ${o.part_b.skill}. Coordinator to confirm and dispatch.`;
      } else if (choice.action === "pair_junior_senior" && choice.chosen_index != null) {
        const o = space.pairJuniorSenior[choice.chosen_index];
        action = "pair_junior_senior";
        proposalForHuman =
          `Send ${o.junior_name} (junior) with ${o.senior_name} (senior supervisor) ` +
          `together. Coordinator to confirm.`;
      }
      // action === "escalate" → keep the defaults.
    } catch (e) {
      notes.push(
        `LLM response failed the edge-case cross-check (${
          e instanceof Error ? e.message : "invalid"
        }) — escalating to a human.`,
      );
    }
  }

  const headline =
    action === "widen_window"
      ? `Edge-case resolved: assign outside the ideal window — ${rationale}`
      : action === "split_visit"
        ? `Edge-case: proposing a split visit for coordinator approval`
        : action === "pair_junior_senior"
          ? `Edge-case: proposing a junior+senior pair for coordinator approval`
          : `Edge-case: no safe automatic fix — escalating to a human`;

  const entry = logDecision(ctx, {
    agent: "AssignmentEdgecaseAgent",
    jobId: input.jobId,
    reasoningKind: "llm",
    input: {
      skill_required: input.skillRequired,
      levers_available: {
        widen_window: space.widenWindow.length,
        split_visit: space.splitVisit.length,
        pair_junior_senior: space.pairJuniorSenior.length,
      },
      llm_mode: resp?.mode ?? "not_called",
      cached: resp?.cached ?? false,
    },
    output: { action, resolved: !!resolvedAssignment },
    headline,
    outcome:
      action === "widen_window"
        ? "auto_commit"
        : action === "escalate"
          ? "requires_approval"
          : "requires_approval",
    requiresApproval: action !== "widen_window",
    latencyMs: resp?.latency_ms ?? 0,
    guardrailNotes: [
      ...(resp?.guardrail_notes ?? []),
      "Only pre-validated levers were offered — certification, working hours and clashes were enforced by the rule layer before the LLM saw them.",
      ...notes,
      action === "widen_window"
        ? "LLM's widen_window pick was independently re-scored against live state before commit."
        : action === "escalate"
          ? "Fell back to human escalation — the always-safe default."
          : "LLM proposal routed to the coordinator, not auto-applied.",
    ],
  });

  return {
    logId: entry.log_id,
    action,
    resolvedAssignment,
    proposalForHuman,
    rationale,
  };
}
