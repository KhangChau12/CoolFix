// ── Deterministic stub responses ────────────────────────────────────
// Used when LLM_MODE=stub. These mimic what Claude Sonnet 4.5 would
// return for each task, derived rule-ishly from the structured input so
// the demo behaves sensibly on novel bookings without any API call.

import type { LlmRequest } from "@/lib/llm";
import type { SkillTag } from "@/lib/types";
import { CATEGORY_HINT_SKILL } from "@/lib/types";

const KEYWORD_SKILL: [RegExp, SkillTag][] = [
  [/gas|refrigerant|not cold|not cooling|leak|icing|frost|top ?up/i, "refrigerant_handling"],
  [/electr|wiring|wire|breaker|isolator|install|power line|trip/i, "electrical_work"],
  [/chiller|office|plant|building|cooling tower|commercial/i, "commercial_chiller"],
  [/clean|servic|filter|maintenance|routine|wash/i, "basic_maintenance"],
];

const INJECTION_RE = [
  /ignore (all|previous|above) instructions/i,
  /you are now/i,
  /system prompt/i,
  /disregard/i,
  /reveal/i,
];

export function stubFor(req: LlmRequest): { data: unknown; extraNotes: string[] } {
  switch (req.task) {
    case "job_intake":
      return stubIntake(req);
    case "disruption_replan":
      return stubDisruption(req);
    case "notification_compose":
      return stubNotification(req);
    case "assignment_edgecase":
      return stubEdgecase(req);
    case "assignment_tiebreak":
      return stubTiebreak(req);
    default:
      return { data: {}, extraNotes: [] };
  }
}

interface StubEdgecaseSpace {
  widen_window: { slot_iso: string; tech_id: string; tech_name: string; added_km: number }[];
  split_visit: unknown[];
  pair_junior_senior: unknown[];
}

/**
 * Stub mode picks a lever deterministically, mirroring what a sensible
 * coordinator does: prefer the smallest schedule disturbance.
 *   1. widen_window — the nearest-technician option (list is added_km-sorted).
 *   2. else pair_junior_senior — supervision keeps quality while using a
 *      junior who's free.
 *   3. else split_visit.
 *   4. else escalate.
 */
function stubEdgecase(req: LlmRequest) {
  const si = req.structuredInput as { edgecase_space: StubEdgecaseSpace };
  const space = si.edgecase_space;

  if (space?.widen_window?.length) {
    const pick = space.widen_window[0];
    return {
      data: {
        action: "widen_window",
        chosen_tech_id: pick.tech_id,
        chosen_slot_iso: pick.slot_iso,
        chosen_index: null,
        rationale: `${pick.tech_name} is certified and free at a nearby slot (+${pick.added_km} km); a small time shift beats making the customer wait for a coordinator.`,
        injection_attempt: false,
      },
      extraNotes: [
        `Stub: chose widen_window (${pick.tech_name}) from ${space.widen_window.length} option(s).`,
      ],
    };
  }

  if (space?.pair_junior_senior?.length) {
    return {
      data: {
        action: "pair_junior_senior",
        chosen_tech_id: null,
        chosen_slot_iso: null,
        chosen_index: 0,
        rationale:
          "No lone certified technician is free, but a junior can take it with a senior supervising — a proposal for the coordinator.",
        injection_attempt: false,
      },
      extraNotes: ["Stub: proposing a junior+senior pair for coordinator approval."],
    };
  }

  if (space?.split_visit?.length) {
    return {
      data: {
        action: "split_visit",
        chosen_tech_id: null,
        chosen_slot_iso: null,
        chosen_index: 0,
        rationale:
          "The job needs two skills and no single technician has both free — split it across two, for the coordinator to confirm.",
        injection_attempt: false,
      },
      extraNotes: ["Stub: proposing a split visit for coordinator approval."],
    };
  }

  return {
    data: {
      action: "escalate",
      chosen_tech_id: null,
      chosen_slot_iso: null,
      chosen_index: null,
      rationale:
        "Every certified technician is booked solid around this time and no split or supervised option is available — a coordinator must handle it.",
      injection_attempt: false,
    },
    extraNotes: ["Stub: no lever available — escalating to a human."],
  };
}

interface StubTiebreakCandidate {
  technician_id: string;
  technician_name: string;
  score_total: number;
  distance_km: number;
  current_workload: number;
  experience_level: "junior" | "senior";
  recent_job_nearby: boolean;
}

/**
 * Stub tie-breaker. A real coordinator, faced with two near-identical
 * scores, prefers: a technician already working nearby (no cold start) >
 * the lower workload > the shorter distance. This mirrors that ordering
 * deterministically so the demo behaves like the LLM would without a call.
 */
function stubTiebreak(req: LlmRequest) {
  const si = req.structuredInput as {
    reason: string;
    candidates: StubTiebreakCandidate[];
  };
  const cands = si.candidates ?? [];
  if (cands.length === 0) {
    return {
      data: {
        chosen_technician_id: null,
        rationale: "No candidates to choose between.",
        injection_attempt: false,
      },
      extraNotes: ["Stub tie-breaker: empty candidate list."],
    };
  }

  const ranked = [...cands].sort((a, b) => {
    if (a.recent_job_nearby !== b.recent_job_nearby) {
      return a.recent_job_nearby ? -1 : 1;
    }
    if (a.current_workload !== b.current_workload) {
      return a.current_workload - b.current_workload;
    }
    return a.distance_km - b.distance_km;
  });
  const pick = ranked[0];
  const top = cands.reduce((m, c) => (c.score_total > m.score_total ? c : m), cands[0]);

  const why = pick.recent_job_nearby
    ? `${pick.technician_name} is already on a job near this address, so there is no extra travel or cold start`
    : pick.current_workload < top.current_workload
      ? `${pick.technician_name} has a lighter workload today (${pick.current_workload} vs ${top.current_workload}), so the day stays balanced`
      : `${pick.technician_name} is the closest of the tied candidates (${pick.distance_km} km)`;

  return {
    data: {
      chosen_technician_id: pick.technician_id,
      rationale: `Scores were within a few percent; ${why}. ${si.reason}`,
      injection_attempt: false,
    },
    extraNotes: [
      `Stub tie-breaker: picked ${pick.technician_name} from ${cands.length} tied candidate(s).`,
    ],
  };
}

function stubIntake(req: LlmRequest) {
  const si = req.structuredInput as {
    problem_category?: string;
    tier?: string;
    hint_skill?: string;
  };
  const text = req.untrustedText ?? "";
  const injection = INJECTION_RE.some((re) => re.test(text));

  const skills = new Set<SkillTag>();
  const catSkill = si.problem_category
    ? CATEGORY_HINT_SKILL[si.problem_category]
    : undefined;
  if (catSkill) skills.add(catSkill);
  for (const [re, sk] of KEYWORD_SKILL) if (re.test(text)) skills.add(sk);
  if (si.hint_skill && !skills.size) skills.add(si.hint_skill as SkillTag);
  if (!skills.size) skills.add("basic_maintenance");

  const urgency =
    si.tier === "urgent"
      ? "high"
      : /urgent|asap|now|immediately|unbearable|too hot|no cooling at all/i.test(text)
        ? "high"
        : si.tier === "priority"
          ? "medium"
          : "low";

  const window: [number, number] =
    si.tier === "urgent"
      ? [2, 22]
      : si.tier === "priority"
        ? [4, 68]
        : si.tier === "standard"
          ? [12, 160]
          : [24, 320];

  return {
    data: {
      skill_required: Array.from(skills),
      urgency_hint: urgency,
      location_note: "",
      time_window_hours: window,
      injection_attempt: injection,
      rationale: `Inferred from the description and category "${si.problem_category ?? "n/a"}"; ${
        injection ? "detected manipulation attempt, ignored." : "nothing unusual."
      }`,
    },
    extraNotes: injection
      ? ["Job-Intake: injection_attempt=true; original task preserved."]
      : [],
  };
}

interface StubReplanSpace {
  bumped_job: {
    job_id: string;
    current_tech_id: string | null;
    current_slot: string;
  };
  allowed_slots_by_tech: Record<string, string[]>;
  movable_soft_jobs: {
    job_id: string;
    current_tech_id: string;
    allowed_slots_by_tech: Record<string, string[]>;
  }[];
}

/**
 * Stub mode is NOT a real LLM, but it DOES design plans within the given
 * legal space (never picks from a pre-built menu — there is no menu). It
 * builds up to 3 plans deterministically:
 *   1. keep the bumped job with its own technician, earliest legal slot
 *      (or, if that technician has no legal slot, the cheapest reassignment).
 *   2. reassign the bumped job to a different certified technician.
 *   3. a 2-step plan: a movable soft job yields its technician's slot and
 *      the bumped job takes it.
 * Every move it emits is drawn verbatim from allowed_slots_by_tech, so it
 * passes the same cross-check a real LLM's output would.
 */
function stubDisruption(req: LlmRequest) {
  const si = req.structuredInput as { replan_space: StubReplanSpace };
  const space = si.replan_space;
  const bumpedId = space?.bumped_job?.job_id;
  const abt = space?.allowed_slots_by_tech ?? {};
  const techIds = Object.keys(abt);

  if (!bumpedId || techIds.length === 0) {
    // Only a multi-step plan could possibly work; try one before giving up.
    const twoStep = stubTwoStepPlan(space);
    if (twoStep) {
      return {
        data: {
          plans: [twoStep],
          recommended_plan_id: twoStep.plan_id,
          injection_attempt: false,
        },
        extraNotes: ["Stub: only a 2-step re-plan is feasible in the legal space."],
      };
    }
    return {
      data: { plans: [], recommended_plan_id: "", injection_attempt: false },
      extraNotes: ["Stub: no legal plan exists in the space."],
    };
  }

  const sorted = (slots: string[]) => [...slots].sort();
  const originalTech = space.bumped_job.current_tech_id;
  const plans: {
    plan_id: string;
    moves: { job_id: string; to_tech_id: string; to_slot_iso: string }[];
    rationale: string;
  }[] = [];

  // Plan 1 — same technician, EARLIEST free slot (least delay).
  if (originalTech && abt[originalTech]?.length) {
    const slots = sorted(abt[originalTech]);
    plans.push({
      plan_id: "p_delay_early",
      moves: [{ job_id: bumpedId, to_tech_id: originalTech, to_slot_iso: slots[0] }],
      rationale:
        "Keep the same technician and delay the job as little as possible.",
    });
    // Plan 2 — same technician, a LATER slot that is likely to have more
    // breathing room around it (the rule layer re-scores and may prefer it).
    if (slots.length > 1) {
      plans.push({
        plan_id: "p_delay_roomy",
        moves: [
          {
            job_id: bumpedId,
            to_tech_id: originalTech,
            to_slot_iso: slots[Math.min(2, slots.length - 1)],
          },
        ],
        rationale:
          "Keep the same technician but pick a slot with a clear gap around it, so a small delay elsewhere doesn't cascade.",
      });
    }
  }

  // Plan 3 — reassign to a different certified technician, earliest slot.
  const altTech = techIds.find((t) => t !== originalTech) ?? techIds[0];
  if (altTech && abt[altTech]?.length) {
    const move = {
      job_id: bumpedId,
      to_tech_id: altTech,
      to_slot_iso: sorted(abt[altTech])[0],
    };
    if (
      !plans.some(
        (p) =>
          p.moves[0].to_tech_id === move.to_tech_id &&
          p.moves[0].to_slot_iso === move.to_slot_iso,
      )
    ) {
      plans.push({
        plan_id: "p_reassign",
        moves: [move],
        rationale:
          "Reassign to another certified technician who can take the job sooner, accepting a little extra travel.",
      });
    }
  }

  // Plan 4 — 2-step (only kept if there's room).
  const twoStep = stubTwoStepPlan(space);
  if (twoStep && plans.length < 3) plans.push(twoStep);

  return {
    data: {
      plans: plans.slice(0, 3),
      recommended_plan_id: plans[0]?.plan_id ?? "",
      injection_attempt: false,
    },
    extraNotes: [
      `Stub: designed ${plans.length} plan(s) inside a legal space of ${techIds.length} technician(s).`,
    ],
  };
}

/** Build a deterministic 2-step plan: a movable soft job steps aside so the
 * bumped job can take a slot on the soft job's current technician. Returns
 * null if no such pairing exists in the space. */
function stubTwoStepPlan(space: StubReplanSpace | undefined) {
  if (!space) return null;
  const bumpedId = space.bumped_job?.job_id;
  if (!bumpedId) return null;
  const abt = space.allowed_slots_by_tech ?? {};
  for (const soft of space.movable_soft_jobs ?? []) {
    const softTech = soft.current_tech_id;
    // The bumped job must be able to use softTech, and the soft job must be
    // able to move somewhere off softTech.
    const bumpedSlots = abt[softTech];
    if (!bumpedSlots?.length) continue;
    const softTargets = Object.entries(soft.allowed_slots_by_tech).filter(
      ([t, slots]) => slots.length > 0 && (t !== softTech || slots.length > 0),
    );
    // Prefer moving the soft job to a different technician; else a later slot
    // on the same one.
    const softTarget =
      softTargets.find(([t]) => t !== softTech) ?? softTargets[0];
    if (!softTarget) continue;
    const [softToTech, softSlots] = softTarget;
    const bumpedSlot = [...bumpedSlots].sort()[0];
    const softSlot = [...softSlots].sort()[0];
    if (softToTech === softTech && softSlot === bumpedSlot) continue; // would re-clash
    return {
      plan_id: "p_twostep",
      moves: [
        { job_id: soft.job_id, to_tech_id: softToTech, to_slot_iso: softSlot },
        { job_id: bumpedId, to_tech_id: softTech, to_slot_iso: bumpedSlot },
      ],
      rationale:
        "Shift a flexible job aside so the urgent job can use the nearest certified technician's slot — two customers moved, but the urgent SLA is met.",
    };
  }
  return null;
}

function stubNotification(req: LlmRequest) {
  const si = req.structuredInput as {
    channel: "technician_app" | "customer_email";
    kind: string;
    job: {
      job_id: string;
      customer_name: string;
      address: string;
      scheduled_time_local: string;
      tier_label: string;
      technician_name?: string;
    };
    change?: { from_local: string; to_local: string; reason: string };
  };
  const j = si.job;

  if (si.channel === "technician_app") {
    if (si.kind === "reschedule") {
      return {
        data: {
          channel: "technician_app",
          subject: `Reschedule: ${j.customer_name}`,
          body:
            `Job ${j.job_id} (${j.customer_name}, ${j.address}) has moved from ` +
            `${si.change?.from_local} to ${si.change?.to_local}. ` +
            `Reason: ${si.change?.reason}. Please tap "Seen" to acknowledge.`,
        },
        extraNotes: [],
      };
    }
    return {
      data: {
        channel: "technician_app",
        subject: `New job: ${j.customer_name} (${j.tier_label})`,
        body:
          `You've been assigned job ${j.job_id}. Customer: ${j.customer_name}. ` +
          `Address: ${j.address}. Appointment: ${j.scheduled_time_local}. ` +
          `Tier: ${j.tier_label}. Tap "Seen" to acknowledge.`,
      },
      extraNotes: [],
    };
  }

  // customer_email
  if (si.kind === "reschedule") {
    return {
      data: {
        channel: "customer_email",
        subject: `CoolFix — your appointment has been updated (${j.job_id})`,
        body:
          `Hi ${j.customer_name},\n\nYour aircon servicing appointment has been moved to ` +
          `${si.change?.to_local} (previously ${si.change?.from_local}) so we could fit in an ` +
          `urgent job in your area. Your technician ${j.technician_name ?? ""} is unchanged. ` +
          `If the new time doesn't work, just reply to this email.\n\n` +
          `Thanks,\nThe CoolFix team`,
      },
      extraNotes: [],
    };
  }
  if (si.kind === "reminder_t3h") {
    return {
      data: {
        channel: "customer_email",
        subject: `CoolFix — reminder for today's appointment (${j.job_id})`,
        body:
          `Hi ${j.customer_name},\n\nTechnician ${j.technician_name ?? ""} will arrive at ` +
          `${j.address} at ${j.scheduled_time_local}. Your slot is now locked in. ` +
          `Please make sure someone is home.\n\nThe CoolFix team`,
      },
      extraNotes: [],
    };
  }
  return {
    data: {
      channel: "customer_email",
      subject: `CoolFix — booking confirmed (${j.job_id})`,
      body:
        `Hi ${j.customer_name},\n\nWe've received your request for ${j.address}. ` +
        `Estimated appointment: ${j.scheduled_time_local} (${j.tier_label} tier). ` +
        `You'll be notified once a technician is assigned.\n\nThe CoolFix team`,
    },
    extraNotes: [],
  };
}
