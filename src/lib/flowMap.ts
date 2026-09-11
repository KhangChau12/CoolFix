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
  AssignmentAgent: "assign",
  AssignmentTiebreakAgent: "tiebrk",
  AssignmentEdgecaseAgent: "edge",
  DisruptionAgent: "disrupt",
  NotificationAgent: "notify",
  // Orchestrator rows are special-cased below (start vs terminal outcome).
  // A historical run's log may still contain a TechnicianStateAgent row
  // (retired — folded into AssignmentAgent, see assignment.ts); it has no
  // station and is simply skipped by computeFlow's `if (!station) continue`.
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

/**
 * One line of the "What happens inside" list, tagged by what role it plays
 * in the station's little narrative arc — every station's `inside` array
 * roughly tells the same 3-beat story (what it's given → what it actually
 * does with it → what limits or follows that), so tagging each bullet
 * lets the modal color them consistently instead of a flat undifferentiated
 * list:
 *   - "input"     — what the station receives or is triggered by.
 *   - "mechanism" — the actual computation / decision / design step; the
 *                   part that answers "so what does it DO".
 *   - "bound"     — a constraint, fallback, or consequence that limits it.
 */
export type InsideKind = "input" | "mechanism" | "bound";
export interface InsideLine {
  kind: InsideKind;
  text: string;
}

function input(text: string): InsideLine {
  return { kind: "input", text };
}
function mechanism(text: string): InsideLine {
  return { kind: "mechanism", text };
}
function bound(text: string): InsideLine {
  return { kind: "bound", text };
}

/**
 * Per-station explanation, split into two layers with two different jobs:
 *
 *   - `intuition`: ONE short line (≤ ~10 words) — the gut-read of "why does
 *     this station exist", shown always-on in the sidebar next to the live
 *     map. Not a summary of `inside` — a different, shorter thing.
 *   - `role` / `inside` / `guard`: the fuller explanation, shown only in
 *     the click-to-open station modal (StationModal in AgentFlowMap.tsx).
 *     `inside` entries are short phrases, not paragraphs, each tagged by
 *     InsideKind so the modal can color-separate them.
 */
export const BRIEF: Record<
  StationId,
  { intuition: string; role: string; inside: InsideLine[]; guard: string }
> = {
  orch: {
    intuition: "The conductor — runs the pipeline, decides auto vs. human.",
    role: "Runs the pipeline for one booking and decides, at the end, whether to commit automatically or stop for a human.",
    inside: [
      input("Receives the raw booking — the only untrusted entry point besides the customer's description."),
      mechanism("Validates it at the edge (email, size caps, tier), then loads roster + jobs + config once so every agent shares that state."),
      bound("Serializes bookings — two can never claim the same slot, even under a burst."),
    ],
    guard: "State is explicit and inspectable — not smeared across ad-hoc queries.",
  },
  intake: {
    intuition: "Turns a customer's messy sentence into clean facts.",
    role: "Reads the customer's free-text symptom description and turns it into structured fields the rest of the pipeline can trust.",
    inside: [
      input("Given the customer's raw problem_description and category hint."),
      mechanism("Outputs skill_required[], an urgency hint, a time window, and an injection_attempt flag."),
      bound("Customer text is boxed as data — the model never follows it as instructions — and the output is re-validated against the skill enum before anything downstream uses it."),
    ],
    guard: "One of only two points where free text is allowed — the other is the outgoing notification.",
  },
  price: {
    intuition: "The number a customer can't argue with or move.",
    role: "Computes the price. Deterministic, no LLM — the number has to be exact and impossible for the customer to move.",
    inside: [
      input("Given the real skill(s) from Job-Intake and the tier — not the customer's dropdown guess."),
      mechanism("price = max(base_price[skill]) × tier multiplier. Priced once, after intake."),
      bound("A “set price to 0” injection changes nothing here — this agent never sees the raw text."),
    ],
    guard: "Rule engine. An LLM here would add cost and randomness for zero benefit.",
  },
  cap: {
    intuition: "Can the fleet actually absorb this job today?",
    role: "Decides whether the fleet can take this job at the requested time — deterministic thresholds plus a per-skill saturation forecast.",
    inside: [
      input("Given the tier, the proposed slot, and the required skill(s)."),
      mechanism("Checks fleet caps (jobs/day, flexible-tier/day) AND a per-skill forecast — certified techs × slots/day, and how many are free ±3h of the slot."),
      bound("Returns accept · accept-with-warning · suggest a later slot — never blocks outright."),
    ],
    guard: "Rule engine — a historical-yield model is the documented next step.",
  },
  assign: {
    intuition: "Who's the best real match — not just who's closest?",
    role: "Reads the technician roster, then scores every eligible one on five components and picks the best. Four hard filters run first.",
    inside: [
      input("Reads the roster from context (least-privilege — location + workload only)."),
      bound("Hard filters remove anyone who fails: certification · working hours · no double-booking · can't reach it in time."),
      mechanism("Score = travel-fit + skill-fit + availability + SLA-headroom + load-balance, each 0–1, weighted by a per-tier policy (Settings)."),
      mechanism("0 eligible + urgent → bump a soft job. 0 eligible → Edge-case agent. Near-tie → Tie-break agent."),
    ],
    guard: "Auditable by design — the feed shows the component bars and every rejection reason.",
  },
  tiebrk: {
    intuition: "A coin-flip the formula shouldn't call alone.",
    role: "Breaks a tie the formula can't. Runs only when the scoring result is effectively a coin-flip.",
    inside: [
      input("Triggers only on: top-2 within 10% · a lone candidate who's strained · a weak urgent fit."),
      mechanism("Picks from the eligible top-3 — everyone already past every hard constraint."),
      bound("The pick is re-scored against live state before use; a bad pick → the formula's #1 stands."),
    ],
    guard: "It re-orders the eligible set — it can never reach past it.",
  },
  edge: {
    intuition: "One last real option, before giving up to a human.",
    role: "Last resort before escalating: when there is no eligible technician and nobody to bump, tries a few levers a real coordinator would.",
    inside: [
      input("Triggers only when Assignment found 0 eligible AND there's no soft job to bump."),
      mechanism("Levers: widen the time window · split the visit · pair junior+senior · escalate."),
      bound("Widen auto-commits after re-validation; split/pair go to a coordinator as a proposal. Can never invent a technician, slot, or skill."),
    ],
    guard: "If nothing safe fits, it escalates rather than forcing an assignment.",
  },
  disrupt: {
    intuition: "Something has to move — this agent designs how.",
    role: "When an urgent job needs a slot another job holds, this agent designs the re-plan — it is not picking from a menu.",
    inside: [
      input("Triggers when the incoming job must bump an existing soft-tier job."),
      mechanism("Rule layer enumerates every legal (technician, time) pair first; the LLM designs 1–3 plans INSIDE that space — never its own slots or numbers."),
      bound("Each plan is re-simulated against live state before use; failure → the best pre-computed mechanical plan."),
    ],
    guard: "The freeze window is absolute — a locked appointment is treated as already-happened.",
  },
  hitl: {
    intuition: "High-impact changes wait for a person. Always.",
    role: "The approval gate. A re-plan reaches a human here whenever it isn't demonstrably low-impact.",
    inside: [
      input("Triggers whenever the chosen re-plan fails even one safety rail."),
      mechanism("Auto-commit needs EVERY rail: ≤1 customer · ≤8km extra travel · 0 SLA breach · flexible-tier only · same day · ≥2h gap · never rescheduled before."),
      bound("Any rail broken → stops here. The coordinator sees quantified trade-offs and picks, or rejects and nothing changes. The threshold is a live dial in Settings."),
    ],
    guard: "Risk-calibrated autonomy: high impact → the system does not act on its own.",
  },
  notify: {
    intuition: "The words that actually reach a person.",
    role: "Writes the actual messages — a short one for the technician app, a full one for the customer email.",
    inside: [
      input("Sees only structured job facts — never the customer's raw description."),
      mechanism("Technician message: terse, asks for “Seen”. Customer message: greeting + sign-off."),
      bound("Fires on a clean commit or an approval — never while the gate holds."),
    ],
    guard: "The second of the two points where free text is allowed to leave the system.",
  },
};
