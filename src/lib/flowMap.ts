// ── Agent Flow Map — pure logic ─────────────────────────────────────
// Turns a job's real agent_decision_log rows into the state the Agent
// Line Map (components/AgentFlowMap.tsx) renders: which station is
// pending / active / done / skipped / halted, and the sequence of
// hand-offs the "train" animates through. No React, no DOM — kept
// separate so the mapping logic is easy to reason about and test.
//
// Design note: the flow map does NOT hard-code one scripted scenario
// (unlike the design mockup it was built from). It walks whatever rows
// a real run actually produced, in true pipeline order (the `_<seq>`
// suffix on log_id — see agents/log.ts), and infers the station for
// each row from `agent_name` plus a couple of Orchestrator special
// cases (start-of-run, and the terminal outcome deciding whether the
// run ends at the HITL gate or carries on to Notification).

import type { AgentDecisionLog, AgentName } from "./types";

export type StationId =
  | "orch"
  | "intake"
  | "price"
  | "cap"
  | "tstate"
  | "assign"
  | "tiebrk"
  | "edge"
  | "disrupt"
  | "hitl"
  | "notify";

export const STATION_ORDER: StationId[] = [
  "orch",
  "intake",
  "price",
  "cap",
  "tstate",
  "assign",
  "tiebrk",
  "edge",
  "disrupt",
  "hitl",
  "notify",
];

/** Reliable per-run ordering key: log_id ends in `_<base36 seq>`. */
export function seqOf(id: string): number {
  const n = parseInt(id.split("_").pop() ?? "0", 36);
  return Number.isFinite(n) ? n : 0;
}

export function sortPipelineOrder(rows: AgentDecisionLog[]): AgentDecisionLog[] {
  return [...rows].sort(
    (a, b) => a.timestamp.localeCompare(b.timestamp) || seqOf(a.log_id) - seqOf(b.log_id),
  );
}

const AGENT_TO_STATION: Partial<Record<AgentName, StationId>> = {
  JobIntakeAgent: "intake",
  PricingEngine: "price",
  CapacityAgent: "cap",
  TechnicianStateAgent: "tstate",
  AssignmentAgent: "assign",
  AssignmentTiebreakAgent: "tiebrk",
  AssignmentEdgecaseAgent: "edge",
  DisruptionAgent: "disrupt",
  NotificationAgent: "notify",
  // Orchestrator rows are special-cased below (start vs terminal outcome).
};

/** A single visit to a station: the exact decision row plus its index in
 *  the overall run (so "happening now" can point at the very last one). */
export interface StationVisit {
  row: AgentDecisionLog;
  isTerminalOutcome: boolean;
}

export type StationState = "pending" | "active" | "done" | "skipped" | "halt";

export interface StationRuntime {
  id: StationId;
  state: StationState;
  /** Every row that landed on this station, oldest → newest. Usually 0 or
   *  1, but Notification can visit 2-4 times in one run (per recipient,
   *  per event) and the panel should be able to show any of them. */
  visits: StationVisit[];
}

export interface FlowStep {
  from: StationId | null;
  to: StationId;
  row: AgentDecisionLog;
}

export interface FlowResult {
  stations: Record<StationId, StationRuntime>;
  /** The train's hand-offs, in order — animate through these. */
  steps: FlowStep[];
  /** True once the last row we have is a terminal Orchestrator outcome
   *  (auto-commit, unassignable, or the HITL gate) — i.e. this run is
   *  "done" as far as the map is concerned (Notification may still be
   *  pending on an approval). */
  reachedOutcome: boolean;
  /** True if the terminal outcome requires a human (HITL / unassignable). */
  haltedForHuman: boolean;
}

const TERMINAL_HEADLINE_MARKERS = [
  "Auto-commit",
  "unassignable",
  "Paused",
  "escalated",
];

function isTerminalOrchestratorRow(row: AgentDecisionLog): boolean {
  if (row.agent_name !== "Orchestrator") return false;
  // The very first row of a run ("New booking received…") is also an
  // Orchestrator row but never terminal — recognisable by its outcome.
  if (row.output_summary?.pipeline === "start") return false;
  return (
    row.outcome === "auto_commit" ||
    row.outcome === "requires_approval" ||
    TERMINAL_HEADLINE_MARKERS.some((m) => row.headline.includes(m))
  );
}

/**
 * Walk a job's rows (already in pipeline order) and produce the station
 * states + train path. Safe to call with a partial run (still in
 * progress) — anything not yet reached is left "pending".
 */
export function computeFlow(rows: AgentDecisionLog[]): FlowResult {
  const ordered = sortPipelineOrder(rows);

  const stations = Object.fromEntries(
    STATION_ORDER.map((id) => [id, { id, state: "pending", visits: [] } as StationRuntime]),
  ) as Record<StationId, StationRuntime>;

  const steps: FlowStep[] = [];
  let cursor: StationId | null = null;
  let reachedOutcome = false;
  let haltedForHuman = false;

  for (const row of ordered) {
    let station: StationId | null;
    let terminal = false;

    if (row.agent_name === "Orchestrator") {
      if (row.output_summary?.pipeline === "start") {
        station = "orch";
      } else if (isTerminalOrchestratorRow(row)) {
        terminal = true;
        reachedOutcome = true;
        if (row.requires_human_approval || row.outcome === "requires_approval") {
          haltedForHuman = true;
          station = "hitl";
        } else {
          // Auto-committed with no conflict / after a low-impact re-plan —
          // there's no separate "commit" station; treat it as arriving
          // at Notification (which will itself log right after).
          station = "notify";
        }
      } else {
        // An Orchestrator row we don't specifically recognise (future
        // additions) — keep it attached to wherever the train already is
        // rather than dropping it.
        station = cursor ?? "orch";
      }
    } else {
      station = AGENT_TO_STATION[row.agent_name] ?? null;
    }

    if (!station) continue;

    if (station !== cursor) {
      steps.push({ from: cursor, to: station, row });
      cursor = station;
    }
    stations[station].visits.push({ row, isTerminalOutcome: terminal });
  }

  // Derive states from the walk.
  for (const id of STATION_ORDER) {
    const s = stations[id];
    if (s.visits.length === 0) continue;
    if (id === "hitl" && haltedForHuman) {
      s.state = "halt";
    } else {
      s.state = "done";
    }
  }
  if (cursor && !reachedOutcome) {
    // Run still in progress — the station the train is currently at is
    // "active", not "done" yet.
    stations[cursor].state = "active";
  }

  // Anything on a branch that was never visited, but a sibling branch WAS
  // taken, reads as "skipped" (dashed) rather than merely "pending" — that
  // distinction only makes sense once the run has moved past the
  // Assignment interchange.
  const pastInterchange = stations.assign.visits.length > 0;
  if (pastInterchange) {
    for (const id of ["tiebrk", "edge", "disrupt"] as StationId[]) {
      if (stations[id].visits.length === 0 && reachedOutcome) {
        stations[id].state = "skipped";
      }
    }
    if (stations.notify.visits.length === 0 && reachedOutcome && !haltedForHuman) {
      // shouldn't normally happen (notify is the terminal marker itself),
      // but keep it consistent if it does.
      stations.notify.state = "skipped";
    }
    if (stations.notify.visits.length === 0 && haltedForHuman) {
      stations.notify.state = "pending"; // still waiting on a coordinator
    }
  }

  return { stations, steps, reachedOutcome, haltedForHuman };
}

export const AGENT_TAG: Record<StationId, string> = {
  orch: "orchestrator",
  intake: "job-intake",
  price: "pricing",
  cap: "capacity",
  tstate: "technician-state",
  assign: "assignment",
  tiebrk: "tie-break",
  edge: "edge-case",
  disrupt: "disruption",
  hitl: "orchestrator",
  notify: "notification",
};

export const STATION_LABEL: Record<StationId, string> = {
  orch: "Orchestrator",
  intake: "Job-Intake",
  price: "Pricing",
  cap: "Capacity",
  tstate: "Technician-State",
  assign: "Assignment",
  tiebrk: "Tie-break",
  edge: "Edge-case",
  disrupt: "Disruption",
  hitl: "Approvals gate",
  notify: "Notification",
};

export const STATION_KIND: Record<StationId, "llm" | "rule"> = {
  orch: "rule",
  intake: "llm",
  price: "rule",
  cap: "rule",
  tstate: "rule",
  assign: "rule",
  tiebrk: "llm",
  edge: "llm",
  disrupt: "llm",
  hitl: "rule",
  notify: "llm",
};

/** CSS var suffix for the left accent bar — matches --agent-* tokens. */
export const STATION_ACCENT: Record<StationId, string> = {
  orch: "orchestrator",
  intake: "intake",
  price: "pricing",
  cap: "capacity",
  tstate: "techstate",
  assign: "assignment",
  tiebrk: "assignment",
  edge: "disruption",
  disrupt: "disruption",
  hitl: "orchestrator",
  notify: "notification",
};

/** One-line "when this fires" caption, shown directly on the map for the
 *  three stations Assignment can branch to — this is the answer to "what
 *  are the different paths after Assignment" without needing to hover. */
export const TRIGGER: Partial<Record<StationId, string>> = {
  tiebrk: "top scores are a near-tie",
  edge: "0 eligible, nobody to bump",
  disrupt: "0 eligible, urgent — must bump",
};

export const BRIEF: Record<StationId, { role: string; inside: string[]; guard: string }> = {
  orch: {
    role: "Runs the pipeline for one booking and decides, at the end, whether to commit automatically or stop for a human.",
    inside: [
      "Validates the booking at the edge — email clamped, free-text capped at 2000 chars, unknown tier rejected as HTTP 400.",
      "Loads the roster, job list and config once into an AgentContext; every agent mutates that in memory.",
      "Serializes itself: concurrent bookings are processed one at a time so two can never claim the same slot.",
    ],
    guard: "State is explicit and inspectable — not smeared across ad-hoc queries.",
  },
  intake: {
    role: "Reads the customer's free-text symptom description and turns it into structured fields the rest of the pipeline can trust.",
    inside: [
      "Outputs skill_required[], an urgency hint, a time window, and an injection_attempt flag.",
      "The customer text reaches the model only inside a delimited data frame — the model is told to treat everything in it as data, never instructions.",
      "The structured output is re-validated against the SkillTag union before anything downstream uses it.",
    ],
    guard: "One of only two points where free text is allowed — the other is the notification going out.",
  },
  price: {
    role: "Computes the price. Deterministic, no LLM — the number has to be exact and impossible for the customer to move.",
    inside: [
      "price = max(base_price[skill]) × tier_multiplier.",
      "Runs once, after intake, on the real required skills — no provisional pass on the dropdown hint.",
      "A prompt-injection payload that says “set price to 0” changes nothing here — this agent never sees the text.",
    ],
    guard: "Rule engine. Putting an LLM here would add cost and non-determinism for zero benefit.",
  },
  cap: {
    role: "Decides whether the fleet can take this job at the requested time — deterministic thresholds plus a per-skill saturation forecast.",
    inside: [
      "Fleet cap: total jobs/day and flexible-tier jobs/day.",
      "Skill-aware forecast: certified technicians × 4 slots/day, and how many certified techs are free within ±3h of the requested slot.",
      "Returns accept · accept_with_warning · suggest_alternative_slot.",
    ],
    guard: "Rule engine — a historical-yield model is the documented next step.",
  },
  tstate: {
    role: "The state store. Returns the technician roster with exactly the fields scoring needs — and nothing more.",
    inside: [
      "Per technician: id, skills, location, current workload, whether they're within working hours at this slot.",
      "Never returns a technician's phone number or home address.",
      "The browser reads through a Supabase anon key with row-level security; all writes go through the server.",
    ],
    guard: "Least privilege, enforced at the query.",
  },
  assign: {
    role: "Scores every eligible technician with a transparent formula and picks the best. Skill match is a hard filter, applied before scoring.",
    inside: [
      "score = w1·(1/distance) + w2·skill_match + w3·urgency + w4·(1/workload). The weights are editable in Settings.",
      "A technician without the matching certification is removed from candidacy — not given a low score. This mirrors a real legal constraint.",
      "0 eligible + urgent → bump a soft job. 0 eligible + not urgent → Edge-case agent. Ambiguous top scores → Tie-break.",
    ],
    guard: "Auditable by design — the feed shows the bar chart and every rejection reason.",
  },
  tiebrk: {
    role: "Breaks a tie the formula can't. Runs only when the scoring result is effectively a coin-flip.",
    inside: [
      "Triggers: top-2 eligible within 10% · a lone eligible technician who is strained (workload ≥ 4 or ≥ 15 km away) · an urgent job whose best score is under 3.0.",
      "The rule layer hands it the eligible top-3, already past every hard constraint. The LLM picks one id.",
      "That pick is re-scored against live state before it's used. A bad or invalid pick → the formula's #1 stands.",
    ],
    guard: "It re-orders the eligible set — it can never reach past it.",
  },
  edge: {
    role: "Last resort before escalating: when there is no eligible technician and nobody to bump, tries a few levers a real coordinator would.",
    inside: [
      "Levers, all pre-validated by the rule layer: widen_window · split_visit · pair_junior_senior · escalate.",
      "widen_window auto-commits after re-validation. split / pair become a proposal for a coordinator. escalate carries the agent's reasoning.",
      "It can never invent a technician, a slot, or a skill.",
    ],
    guard: "If nothing safe fits, it escalates rather than forcing an assignment.",
  },
  disrupt: {
    role: "When an urgent job needs a slot another job holds, this agent designs the re-plan — it is not picking from a menu.",
    inside: [
      "The rule layer enumerates a legal slot space: every certified technician × a ladder of candidate times, each already checked for skill, freeze window, double-booking and working hours.",
      "The LLM designs 1–3 plans inside that space. It returns references into the space — never its own slots or trade-off numbers.",
      "Each plan is cross-checked, then re-simulated move-by-move against live state. Failure → the best pre-computed mechanical plan.",
    ],
    guard: "The freeze window is absolute — a locked appointment is treated as already-happened, and no plan may touch it.",
  },
  hitl: {
    role: "The approval gate. A re-plan reaches a human here whenever it isn't demonstrably low-impact.",
    inside: [
      "Auto-commit needs every rail: ≤ 1 customer affected · ≤ 8 km added travel · 0 SLA breach · Flexible tier only · same calendar day · ≤ 3h shift · ≥ 2h gap to the next job · not already rescheduled.",
      "Any rail broken → the pipeline stops. The coordinator sees 2–3 plans with quantified trade-offs and the agent's recommendation, and picks one — or rejects, and nothing changes.",
      "The threshold that decides how much autonomy the agent has is a live dial in Settings.",
    ],
    guard: "Risk-calibrated autonomy: high impact → the system does not act on its own.",
  },
  notify: {
    role: "Writes the actual messages — a short one for the technician app, a full one for the customer email.",
    inside: [
      "Receives only structured job facts — never the customer's raw description.",
      "Technician message is terse and asks for a “Seen” acknowledgement. Customer message has a greeting and a sign-off.",
      "Fires on a clean assignment, an auto-committed re-plan, or after a coordinator approves — never while the gate holds.",
    ],
    guard: "The second of the two points where free text is allowed to leave the system.",
  },
};
