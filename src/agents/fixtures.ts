// ── Deterministic stub responses ────────────────────────────────────
// Used when LLM_MODE=stub. These mimic what Claude Sonnet 4.5 would
// return for each task, derived rule-ishly from the structured input so
// the demo behaves sensibly on novel bookings without any API call.

import type { LlmRequest } from "@/lib/llm";
import type { SkillTag } from "@/lib/types";
import { CATEGORY_HINT_SKILL } from "@/lib/types";
import { heuristicCost, summariseOption } from "./disruption";

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
    default:
      return { data: {}, extraNotes: [] };
  }
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

interface StubCandidateMoveDTO {
  option_id: string;
  label: string;
  moves: unknown[];
  trade_offs: {
    customers_affected: number;
    total_added_travel_km: number;
    sla_breaches: number;
    frozen_jobs_touched: number;
  };
}

/**
 * Stub mode is NOT a real LLM — it does a real deterministic "rank the
 * pre-filtered shortlist by cost" search, using the exact same
 * heuristicCost() formula the mechanical generator uses to pre-filter,
 * so stub behavior stays legible and consistent with bedrock mode's
 * stated priority order (fewer SLA breaches > fewer customers affected >
 * less added travel).
 */
function stubDisruption(req: LlmRequest) {
  const si = req.structuredInput as { candidate_moves: StubCandidateMoveDTO[] };
  const cands = si.candidate_moves ?? [];
  if (cands.length === 0) {
    return {
      data: { ranked_option_ids: [], summaries: {}, recommended_option_id: "", injection_attempt: false },
      extraNotes: [],
    };
  }

  const ranked = [...cands].sort((a, b) => heuristicCost(a.trade_offs) - heuristicCost(b.trade_offs));

  return {
    data: {
      ranked_option_ids: ranked.map((c) => c.option_id),
      summaries: Object.fromEntries(ranked.map((c) => [c.option_id, summariseOption(c)])),
      recommended_option_id: ranked[0].option_id,
      injection_attempt: false,
    },
    extraNotes: [
      `Stub: searched ${cands.length} pre-filtered candidate(s), picked ${ranked[0].option_id} by cost formula.`,
    ],
  };
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
