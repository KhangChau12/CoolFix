"use client";

// ── Agent Flow Map ───────────────────────────────────────────────────
// Live "metro map" view of one job's pipeline: a station per agent,
// connected by rails in real pipeline order, with a train animating each
// hand-off as it actually happens. Reads exactly the same
// agent_decision_log rows as AgentFeed / PipelineReplay — this is a
// second, more cinematic render of the same data, not a separate model.
//
// Meant to run side-by-side with /book in a second window: submit a
// booking there, watch it live here. Follows whatever job is passed in;
// the page wrapper (app/admin/flow/page.tsx) decides which job that is
// (latest booking by default).

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiGet } from "@/lib/client";
import { useRealtime } from "./useRealtime";
import {
  computeFlow,
  sortPipelineOrder,
  STATION_ORDER,
  STATION_LABEL,
  STATION_KIND,
  STATION_ACCENT,
  AGENT_TAG,
  BRIEF,
  TRIGGER,
  type StationId,
  type StationRuntime,
  type FlowStep,
} from "@/lib/flowMap";
import { Candidates, ReplanOptions } from "./PipelineReplay";
import { ScoreBars, ScoringExplainer } from "./scoring";
import type { AgentDecisionLog, Job } from "@/lib/types";

// ── layout — a 3-tier "Z" grid, no diagonal or overlapping routes ──
// Tier 1: Orchestrator → Job-Intake → Pricing (left to right).
// Tier 2: Capacity → Technician-State → Assignment → Notification — the
//   line drops down under Orchestrator's column and continues rightward,
//   like a paragraph wrapping to its next line. Cards are large because
//   nothing is squeezed to fit 7 stations across one row.
// Tier 3: Tie-break / Edge-case / Disruption / Approvals gate — the three
//   independent branches Assignment can take, well below tier 2, each
//   under its own column so a straight vertical drop never crosses a
//   card that isn't its endpoint.
const CW = 188;
const CH = 56;
// Tier-3 cards (the 3 branches off Assignment) are taller: the "fires
// when" trigger caption lives INSIDE the card, as a second line under the
// name, instead of floating below it where it used to collide with the
// return-to-Notification arc. Rail anchor points still use CH — only the
// drawn box grows — so the column/row math below is untouched.
const CH3 = 74;
const COL_W = 234; // column pitch: card width + a generous fixed gutter
const TIER_GAP = 190;
const T1_Y = 50;
const T2_Y = T1_Y + TIER_GAP;
const T3_Y = T2_Y + TIER_GAP;
const PAD_X = 110;

const TIER1_IDS: StationId[] = ["orch", "intake", "price"];
const TIER2_IDS: StationId[] = ["cap", "tstate", "assign", "notify"]; // columns 0-3
// Tier 3, evenly spaced across the same 4 columns as tier 2. Disruption
// lands at column 2 by construction — directly under Assignment (also
// column 2) — which is the one branch whose drop must be a plain
// vertical line; the other two use a short elbow so exact alignment
// doesn't matter for them.
const TIER3_IDS: StationId[] = ["tiebrk", "edge", "disrupt", "hitl"];

const POS: Record<StationId, { cx: number; cy: number }> = Object.fromEntries([
  ...TIER1_IDS.map((id, i) => [id, { cx: PAD_X + COL_W * i, cy: T1_Y }] as const),
  ...TIER2_IDS.map((id, i) => [id, { cx: PAD_X + COL_W * i, cy: T2_Y }] as const),
  ...TIER3_IDS.map((id, i) => [id, { cx: PAD_X + COL_W * i, cy: T3_Y }] as const),
]) as Record<StationId, { cx: number; cy: number }>;

const VW = PAD_X + COL_W * 3 + CW / 2 + 60;
// Bottom margin has to clear: the tall tier-3 card + a visible gap +
// the return-arc's dip + a bit of breathing room below that.
const VH = T3_Y + CH3 - CH / 2 + 70;

// Tier-3 stations render a taller box (CH3) to fit the "fires when"
// caption inside the card; every other station uses the plain CH anchor.
const TALL_IDS = new Set<StationId>(["tiebrk", "edge", "disrupt", "hitl"]);
function boxHalfHeight(id: StationId) {
  return (TALL_IDS.has(id) ? CH3 : CH) / 2;
}

function edgePt(id: StationId, side: "l" | "r" | "t" | "b") {
  const s = POS[id];
  if (side === "r") return { x: s.cx + CW / 2, y: s.cy };
  if (side === "l") return { x: s.cx - CW / 2, y: s.cy };
  if (side === "t") return { x: s.cx, y: s.cy - CH / 2 };
  return { x: s.cx, y: s.cy + CH / 2 };
}
// Like edgePt(id, "b") but from the VISIBLE bottom of the card (which for
// tier-3 stations sits lower than the CH-based rail anchor, because their
// box is taller). Used only by the return-to-Notification arcs, so they
// start clear of the trigger caption instead of cutting through it.
function visibleBottom(id: StationId) {
  const s = POS[id];
  return { x: s.cx, y: s.cy + boxHalfHeight(id) };
}

const R = 16;
function seg(ax: number, ay: number, bx: number, by: number) {
  return `M ${ax} ${ay} L ${bx} ${by}`;
}
// A straight vertical drop from A's bottom into B's top — only valid
// when A and B share a column (used for the tier-2 → tier-3 branches,
// which are laid out under Assignment's column and to its right, one per
// column, precisely so this never needs a horizontal jog).
function dropStraight(a: StationId, b: StationId) {
  const A = edgePt(a, "b");
  const B = edgePt(b, "t");
  return seg(A.x, A.y, B.x, B.y);
}
// The tier-1 → tier-2 "line wrap": down from A's bottom, one rounded
// corner, left across to B's column, one more rounded corner, down into
// B's top. Used once, for Pricing → Capacity.
function wrapDown(a: StationId, b: StationId) {
  const A = edgePt(a, "b");
  const B = edgePt(b, "t");
  const midY = (A.y + B.y) / 2;
  const sx = B.x > A.x ? 1 : B.x < A.x ? -1 : 0;
  if (sx === 0) return seg(A.x, A.y, B.x, B.y);
  return `M ${A.x} ${A.y} L ${A.x} ${midY - R} Q ${A.x} ${midY} ${A.x + sx * R} ${midY} L ${B.x - sx * R} ${midY} Q ${B.x} ${midY} ${B.x} ${midY + R} L ${B.x} ${B.y}`;
}
// A wide arc well below tier 3, for every rail that has to reach
// Notification (tier 2, rightmost column) from somewhere in tier 3 —
// dips below the lowest row entirely so it never crosses a card, no
// matter how many of these run in parallel (only one ever does, but the
// geometry doesn't depend on that).
function lowArc(a: StationId, b: StationId) {
  const A = visibleBottom(a);
  const B = edgePt(b, "b");
  const dipY = VH - 20;
  return `M ${A.x} ${A.y} L ${A.x} ${dipY - R} Q ${A.x} ${dipY} ${A.x + (B.x > A.x ? R : -R)} ${dipY} L ${B.x - (B.x > A.x ? R : -R)} ${dipY} Q ${B.x} ${dipY} ${B.x} ${dipY - R} L ${B.x} ${B.y}`;
}

interface RailDef {
  id: string;
  a: StationId;
  b: StationId;
  cls: "main" | "branch" | "branch dim" | "halt" | "ghost";
  d: string;
}

const RAILS: RailDef[] = [
  // tier 1, straight across
  { id: "orch-intake", a: "orch", b: "intake", cls: "main", d: seg(edgePt("orch", "r").x, edgePt("orch", "r").y, edgePt("intake", "l").x, edgePt("intake", "l").y) },
  { id: "intake-price", a: "intake", b: "price", cls: "main", d: seg(edgePt("intake", "r").x, edgePt("intake", "r").y, edgePt("price", "l").x, edgePt("price", "l").y) },

  // tier 1 → tier 2: the line "wraps" like text, Pricing down to Capacity
  { id: "price-cap", a: "price", b: "cap", cls: "main", d: wrapDown("price", "cap") },

  // tier 2, straight across
  { id: "cap-tstate", a: "cap", b: "tstate", cls: "main", d: seg(edgePt("cap", "r").x, edgePt("cap", "r").y, edgePt("tstate", "l").x, edgePt("tstate", "l").y) },
  { id: "tstate-assign", a: "tstate", b: "assign", cls: "main", d: seg(edgePt("tstate", "r").x, edgePt("tstate", "r").y, edgePt("assign", "l").x, edgePt("assign", "l").y) },
  { id: "assign-notify", a: "assign", b: "notify", cls: "main", d: seg(edgePt("assign", "r").x, edgePt("assign", "r").y, edgePt("notify", "l").x, edgePt("notify", "l").y) },

  // tier 2 → tier 3: Tie-break, Edge-case and Disruption are three
  // INDEPENDENT alternatives from Assignment — only one ever runs per
  // booking. Disruption sits directly under Assignment (both column 2),
  // so that drop is a plain vertical line; Tie-break and Edge-case sit
  // one and two columns to its left, reached by a short elbow (down,
  // across, down) that stays entirely in the gap between tier 2 and
  // tier 3 — never over a card.
  { id: "assign-tiebrk", a: "assign", b: "tiebrk", cls: "branch dim", d: wrapDown("assign", "tiebrk") },
  { id: "assign-edge", a: "assign", b: "edge", cls: "branch dim", d: wrapDown("assign", "edge") },
  { id: "assign-disrupt", a: "assign", b: "disrupt", cls: "branch", d: dropStraight("assign", "disrupt") },

  // Disruption's own two outcomes: escalate to a human (→ Approvals gate,
  // same tier, straight across) or clear every safety rail and continue
  // to Notification (a low arc that dips below tier 3 entirely).
  { id: "disrupt-hitl", a: "disrupt", b: "hitl", cls: "halt", d: seg(edgePt("disrupt", "r").x, edgePt("disrupt", "r").y, edgePt("hitl", "l").x, edgePt("hitl", "l").y) },
  { id: "disrupt-notify", a: "disrupt", b: "notify", cls: "ghost", d: lowArc("disrupt", "notify") },

  // Once a coordinator approves at the gate, the run continues to Notification.
  { id: "hitl-notify", a: "hitl", b: "notify", cls: "ghost", d: lowArc("hitl", "notify") },

  // Tie-break / Edge-case each resolve back onto the main line at
  // Notification too (a clean pick, or a widened-window auto-commit).
  { id: "tiebrk-notify", a: "tiebrk", b: "notify", cls: "ghost", d: lowArc("tiebrk", "notify") },
  { id: "edge-notify", a: "edge", b: "notify", cls: "ghost", d: lowArc("edge", "notify") },
];

// The 4 "return to Notification" rails only ever matter for whichever ONE
// branch actually ran — showing all 4 as dashed arcs at once (the old
// behaviour) crowded the bottom of the map with paths that will never all
// be relevant simultaneously. They're drawn only once their source
// station has a real visit; idle, none of them show at all.
const RETURN_RAIL_IDS = new Set(["disrupt-notify", "hitl-notify", "tiebrk-notify", "edge-notify"]);

const RAIL_BY_PAIR = new Map(RAILS.map((r) => [`${r.a}->${r.b}`, r]));

// ── component ────────────────────────────────────────────────────────

interface Props {
  jobId: string | null;
  job: Job | null;
}

export function AgentFlowMap({ jobId, job }: Props) {
  const [rows, setRows] = useState<AgentDecisionLog[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!jobId) {
      setRows([]);
      setLoaded(true);
      return;
    }
    try {
      const { decisions } = await apiGet<{ decisions: AgentDecisionLog[] }>(
        `/api/decisions?job=${encodeURIComponent(jobId)}&limit=200`,
      );
      setRows(sortPipelineOrder(decisions));
      setLoaded(true);
    } catch {
      /* keep last */
    }
  }, [jobId]);

  const conn = useRealtime("agent_decision_log", load);
  useEffect(() => {
    load();
  }, [load]);

  const flow = useMemo(() => computeFlow(rows), [rows]);
  const steps = flow.steps;

  // ── the train: play the hand-offs in order ─────────────────────────
  // A judge watching should see the train actually travel each rail, even
  // when a burst of rows lands between two polls. The animation loop must
  // NOT restart every time the data is re-fetched — `steps` is a fresh
  // array on every poll even when its contents are unchanged. So the loop
  // is driven off `steps.length` (a number) and reads step content from a
  // ref; a self-scheduling timeout walks the cursor forward one hop at a
  // time and is only torn down when the job changes.
  const [shownStepCount, setShownStepCount] = useState(0);
  const [train, setTrain] = useState<{
    path: string;
    dur: number;
    cls: string;
    key: number;
    phase: "run" | "fade";
  } | null>(null);

  const stepsRef = useRef<FlowStep[]>(steps);
  stepsRef.current = steps;
  const shownRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hopKeyRef = useRef(0);
  const stepsLen = steps.length;

  // Reset when the job changes.
  useEffect(() => {
    shownRef.current = 0;
    setShownStepCount(0);
    setTrain(null);
    setLoaded(false);
    if (timerRef.current) clearTimeout(timerRef.current);
  }, [jobId]);

  // The walk is owned by one long-lived effect keyed on `jobId` only — it
  // is NOT torn down when new rows arrive, so an in-flight hop is never
  // interrupted by a poll. A second effect just "nudges" the loop awake
  // when the hop count grows while it was idle (caught up).
  const advanceRef = useRef<() => void>(() => {});

  useEffect(() => {
    const advance = () => {
      const all = stepsRef.current;
      const cursor = shownRef.current;
      if (cursor >= all.length) {
        // caught up — go idle and wait for the effect to re-run with more
        // hops. Clearing the ref is what lets that re-run restart the loop.
        timerRef.current = null;
        setTrain(null);
        return;
      }
      const step = all[cursor];
      const rail = step.from ? RAIL_BY_PAIR.get(`${step.from}->${step.to}`) : null;

      if (!rail) {
        // First station, or a hop with no drawn rail — reveal after a beat.
        timerRef.current = setTimeout(() => {
          shownRef.current = cursor + 1;
          setShownStepCount(cursor + 1);
          advance();
        }, 240);
        return;
      }

      const isArc = rail.cls === "ghost" || rail.d.includes("Q");
      const dur = rail.cls === "halt" ? 820 : isArc ? 720 : 560;
      const key = ++hopKeyRef.current;
      setTrain({ path: rail.d, dur, cls: rail.cls, key, phase: "run" });

      // Run the motion, then a short fade, then commit the hop and continue.
      timerRef.current = setTimeout(() => {
        setTrain((t) => (t && t.key === key ? { ...t, phase: "fade" } : t));
        timerRef.current = setTimeout(() => {
          setTrain((t) => (t && t.key === key ? null : t));
          shownRef.current = cursor + 1;
          setShownStepCount(cursor + 1);
          advance();
        }, 180);
      }, dur);
    };

    advanceRef.current = advance;

    // Kick the loop for this job. If it's mid-hop (timer pending) leave it;
    // it self-continues.
    if (shownRef.current < stepsRef.current.length && timerRef.current === null) {
      advance();
    }

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // Nudge: when more hops land while the train sits idle (caught up), wake
  // the loop. A no-op if a hop is already running.
  useEffect(() => {
    if (shownRef.current < stepsLen && timerRef.current === null) {
      advanceRef.current();
    }
  }, [stepsLen]);

  // The "visible" flow state is computed only through the hops the train
  // has actually completed — stations beyond the cursor stay pending even
  // if the DB already has the row, so the reveal is paced not snapped.
  const visibleFlow = useMemo(() => {
    if (shownStepCount >= steps.length) return flow;
    const visibleRows: AgentDecisionLog[] = [];
    for (let i = 0; i < shownStepCount; i++) visibleRows.push(steps[i].row);
    return computeFlow(visibleRows);
  }, [flow, steps, shownStepCount]);

  const isCatchingUp = shownStepCount < steps.length;

  // ── selection: hover / click a station, or auto-follow the active one ──
  const [pinnedId, setPinnedId] = useState<StationId | null>(null);
  const [hoverId, setHoverId] = useState<StationId | null>(null);
  const [panelView, setPanelView] = useState<"did" | "role">("did");
  const [visitIdx, setVisitIdx] = useState(0);

  const activeId = useMemo<StationId | null>(() => {
    for (const id of STATION_ORDER) if (visibleFlow.stations[id].state === "active") return id;
    return null;
  }, [visibleFlow]);

  // Auto-follow the active/most-recent station while nothing is pinned.
  const lastDoneId = useMemo<StationId | null>(() => {
    let last: StationId | null = null;
    for (let i = 0; i < shownStepCount; i++) last = steps[i].to;
    return last;
  }, [steps, shownStepCount]);

  const shownId = pinnedId ?? hoverId ?? activeId ?? lastDoneId;

  useEffect(() => {
    // reset to the latest visit whenever the shown station changes
    setVisitIdx(0);
    setPanelView("did");
  }, [shownId]);

  return (
    <div>
      <div
        className="row"
        style={{ gap: 18, flexWrap: "wrap", fontSize: 11, color: "var(--text-muted)", marginBottom: 12, padding: "0 2px" }}
      >
        <LegendSwatch cls="main" label="Main line · rule engine" />
        <LegendSwatch cls="branch" label="LLM branch · judgement" />
        <LegendSwatch cls="halt" label="HITL · needs a human" />
        <LegendSwatch cls="dim" label="Not in service this run" />
        <span className="row" style={{ gap: 6, fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: "0.02em", textTransform: "uppercase" }}>
          <span style={{ width: 10, height: 7, borderRadius: 2, background: "var(--train, #e07a1f)", boxShadow: "0 0 6px rgba(224,122,31,0.55)" }} />
          the train = one hand-off, moving between agents
        </span>
        <span className="spread" style={{ marginLeft: "auto", gap: 6 }}>
          <span className={conn === "live" ? "live-dot" : ""} style={{ width: 7, height: 7, borderRadius: 999, background: conn === "live" ? undefined : "var(--text-faint)" }} />
          <span className="mono faint" style={{ fontSize: 10.5 }}>
            {conn === "live" ? "live" : conn === "polling" ? "polling" : "connecting"}
          </span>
        </span>
      </div>

      <div className="stage-grid">
        <div>
          <div
            className="card"
            style={{ padding: 8, position: "relative", overflow: "hidden" }}
          >
            {jobId && !loaded && (
              <div style={{ padding: 60, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
                Loading…
              </div>
            )}
            {!jobId && (
              <div style={{ padding: 60, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
                No booking yet. Submit one from the Customer form (<code className="mono">/book</code>) and it will
                appear here automatically.
              </div>
            )}
            {jobId && loaded && (
              <div style={{ position: "relative", width: "100%", aspectRatio: `${VW} / ${VH}`, minHeight: 380 }}>
                <svg
                  viewBox={`0 0 ${VW} ${VH}`}
                  preserveAspectRatio="xMidYMid meet"
                  style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible" }}
                  aria-hidden="true"
                >
                  <FlowSvgInner
                    stations={visibleFlow.stations}
                    train={train}
                    hoverId={hoverId}
                    pinnedId={pinnedId}
                    onHover={setHoverId}
                    onLeave={() => setHoverId(null)}
                    onClick={(id) => setPinnedId((p) => (p === id ? null : id))}
                  />
                </svg>
              </div>
            )}
          </div>
        </div>

        <DetailPanel
          jobId={jobId}
          shownId={shownId}
          station={shownId ? visibleFlow.stations[shownId] : null}
          isLive={shownId !== null && shownId === activeId}
          pinned={pinnedId !== null && pinnedId === shownId}
          view={panelView}
          setView={setPanelView}
          visitIdx={visitIdx}
          setVisitIdx={setVisitIdx}
          catchingUp={isCatchingUp}
        />
      </div>

      {job && (
        <div className="foot" style={{ marginTop: 20 }}>
          Each station is a real <code>agent_decision_log</code> row — agent, <code>reasoning_kind</code>,{" "}
          <code>latency_ms</code>, score breakdown, candidates, re-plan options, guardrails — drawn as a live line
          map instead of a list. The train animates one hand-off; a dashed station is an agent that did not run
          this time; the red station is the HITL gate. Hover or click any station for its role and, once it has
          run, exactly what it decided.
        </div>
      )}
    </div>
  );
}

function LegendSwatch({ cls, label }: { cls: string; label: string }) {
  const bg =
    cls === "main"
      ? "var(--border-strong)"
      : cls === "branch"
        ? "var(--llm-ink)"
        : cls === "halt"
          ? "var(--tier-urgent)"
          : "var(--border)";
  return (
    <span className="row" style={{ gap: 7 }}>
      <span style={{ width: 22, height: 4, borderRadius: 2, background: bg }} />
      <span className="mono" style={{ fontSize: 9.5, letterSpacing: "0.02em", textTransform: "uppercase" }}>
        {label}
      </span>
    </span>
  );
}

// ── SVG map contents ──────────────────────────────────────────────────

function FlowSvgInner({
  stations,
  train,
  hoverId,
  pinnedId,
  onHover,
  onLeave,
  onClick,
}: {
  stations: Record<StationId, StationRuntime>;
  train: { path: string; dur: number; cls: string; key: number; phase: "run" | "fade" } | null;
  hoverId: StationId | null;
  pinnedId: StationId | null;
  onHover: (id: StationId) => void;
  onLeave: () => void;
  onClick: (id: StationId) => void;
}) {
  return (
    <>
      {(() => {
        // Has ANY run data landed yet? While idle (nothing has run), every
        // branch is drawn with equal weight so the branching structure
        // itself — "these are the 3 things that can happen after
        // Assignment" — reads clearly. Once a run is under way, the
        // branches that weren't taken this time fade back so the one that
        // WAS taken stands out.
        const anyRun = STATION_ORDER.some((id) => stations[id].visits.length > 0);
        return RAILS.filter((r) => {
          // Return-to-Notification arcs only ever matter for the one
          // branch that actually ran this time — don't draw the other 3
          // as idle clutter.
          if (RETURN_RAIL_IDS.has(r.id)) return stations[r.a].visits.length > 0;
          return true;
        }).map((r) => {
          const isBranchKind = r.cls === "branch" || r.cls === "branch dim" || r.cls === "ghost";
          const bRan = stations[r.b].visits.length > 0;
          const aRan = stations[r.a].visits.length > 0;
          const doneMain = r.cls === "main" && bRan && aRan;
          const doneBranch = isBranchKind && bRan && aRan;
          const takenThisRun = doneMain || doneBranch || r.cls === "halt";

          // idle (no run yet): every branch rail is a plain, legible
          // dashed line in the neutral "structure" colour — not tied to
          // any one agent's accent, since none of them have happened.
          const stroke = takenThisRun
            ? r.cls === "halt"
              ? "var(--tier-urgent)"
              : doneMain
                ? "var(--brand)"
                : "var(--llm-ink)"
            : r.cls === "main"
              ? "var(--border-strong)"
              : "var(--text-faint)";

          const dashed = isBranchKind && !takenThisRun;
          return (
            <path
              key={r.id}
              d={r.d}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
              stroke={stroke}
              strokeWidth={r.cls === "main" ? 5.5 : r.cls === "halt" ? 4.5 : 3.4}
              strokeDasharray={dashed ? "1.5 7" : undefined}
              opacity={dashed ? (anyRun ? 0.55 : 0.9) : 1}
            />
          );
        });
      })()}

      {/* "3 possible paths" caption, sitting in the gap between tier 2 and
          tier 3, right where the split actually happens — answers "what
          are the different outcomes after Assignment" at the one place a
          viewer is looking when they ask that question. */}
      <text
        x={POS.tiebrk.cx - CW / 2}
        y={(T2_Y + T3_Y) / 2 - 6}
        fontFamily="var(--mono)"
        fontSize="9.5"
        fontWeight={700}
        letterSpacing="0.03em"
        fill="var(--text-faint)"
      >
        ASSIGNMENT PICKS ONE OF 3 PATHS BELOW ↓
      </text>

      {train && (
        // key on a per-hop counter so each hand-off remounts the group and
        // its SMIL <animateMotion> actually restarts (mutating the attribute
        // alone does not reliably re-trigger a running SMIL animation).
        // rotate="auto" is only safe on straight segments — on the elbow /
        // arc rails (which contain Q curves) it makes the car spin at every
        // corner, so those get a fixed orientation instead.
        <g
          key={train.key}
          className="fm-train"
          style={{
            opacity: train.phase === "fade" ? 0 : 1,
            transition: "opacity 0.18s linear",
          }}
        >
          <rect
            width="19"
            height="11"
            rx="3.5"
            x="-9.5"
            y="-5.5"
            fill={train.cls === "halt" ? "var(--tier-urgent)" : "var(--tier-priority)"}
            stroke="#fff"
            strokeWidth="1.5"
            strokeOpacity="0.5"
          >
            <animateMotion
              dur={`${train.dur / 1000}s`}
              path={train.path}
              fill="freeze"
              rotate={train.path.includes("Q") ? "0" : "auto"}
              begin="0s"
            />
            {/* a soft glowing pulse riding with the car */}
            <animate
              attributeName="fill-opacity"
              values="0.7;1;0.7"
              dur="0.9s"
              repeatCount="indefinite"
            />
          </rect>
        </g>
      )}

      {STATION_ORDER.map((id) => (
        <Station
          key={id}
          id={id}
          runtime={stations[id]}
          isHover={hoverId === id}
          isPinned={pinnedId === id}
          onHover={onHover}
          onLeave={onLeave}
          onClick={onClick}
        />
      ))}
    </>
  );
}

function Station({
  id,
  runtime,
  isHover,
  isPinned,
  onHover,
  onLeave,
  onClick,
}: {
  id: StationId;
  runtime: StationRuntime;
  isHover: boolean;
  isPinned: boolean;
  onHover: (id: StationId) => void;
  onLeave: () => void;
  onClick: (id: StationId) => void;
}) {
  const { cx, cy } = POS[id];
  const kind = STATION_KIND[id];
  const state = runtime.state;
  const latest = runtime.visits[runtime.visits.length - 1]?.row;
  const trigger = TRIGGER[id];
  const boxH = trigger ? CH3 : CH;
  const halfH = boxH / 2;
  // The card is anchored to the SAME top edge as the plain CH box (so
  // rail connections drawn with edgePt/dropStraight still land exactly
  // on the card's top/side edges) but grows downward to fit the caption.
  const topY = -CH / 2;

  const ringColor =
    state === "halt"
      ? "var(--tier-urgent)"
      : state === "active"
        ? "var(--tier-priority)"
        : state === "done"
          ? "var(--brand)"
          : isHover || isPinned
            ? "var(--brand)"
            : "var(--border-strong)";
  const ringWidth = state === "pending" ? 1.5 : 2.5;
  const fill = state === "pending" ? "var(--surface-2)" : state === "halt" ? "var(--tier-urgent-bg)" : "var(--surface)";

  return (
    <g
      transform={`translate(${cx} ${cy})`}
      style={{ cursor: "pointer" }}
      tabIndex={0}
      role="button"
      aria-label={`${STATION_LABEL[id]} — ${kind === "llm" ? "LLM agent" : "rule engine"}`}
      onMouseEnter={() => onHover(id)}
      onMouseLeave={onLeave}
      onFocus={() => onHover(id)}
      onClick={() => onClick(id)}
    >
      {state === "active" && (
        <rect
          x={-CW / 2 - 4}
          y={topY - 4}
          width={CW + 8}
          height={boxH + 8}
          rx="13"
          fill="none"
          stroke="var(--tier-priority)"
          strokeWidth="2"
          className="fm-halo"
        />
      )}
      <rect
        x={-CW / 2}
        y={topY}
        width={CW}
        height={boxH}
        rx="10"
        fill={fill}
        stroke={ringColor}
        strokeWidth={ringWidth}
        strokeDasharray={state === "skipped" ? "4 4" : undefined}
        style={{
          transition: "stroke 0.2s, stroke-width 0.2s",
          filter:
            state === "active"
              ? "drop-shadow(0 3px 14px rgba(224,122,31,0.4))"
              : state === "halt"
                ? "drop-shadow(0 3px 16px rgba(208,52,44,0.4))"
                : state === "done"
                  ? "drop-shadow(0 2px 6px rgba(37,99,235,0.16))"
                  : undefined,
        }}
      />
      <rect
        x={-CW / 2}
        y={topY + 8}
        width="3.5"
        height={CH - 16}
        rx="2"
        fill={`var(--agent-flow-${STATION_ACCENT[id]})`}
        opacity={state === "skipped" ? 0.3 : 1}
      />
      {trigger && <line x1={-CW / 2 + 12} y1={topY + CH} x2={CW / 2 - 12} y2={topY + CH} stroke="var(--border)" strokeWidth="1" />}

      {/* status disc, top-right corner */}
      {state !== "pending" && (
        <>
          <circle
            cx={CW / 2 - 2}
            cy={topY - 1}
            r="8"
            fill={state === "active" ? "var(--tier-priority)" : state === "halt" ? "var(--tier-urgent)" : "var(--brand)"}
          />
          {state === "active" ? (
            // three dots fading in sequence — a "working" indicator with no
            // transform (see .fm-dot in globals.css for why)
            <g>
              <circle className="fm-dot" cx={CW / 2 - 6} cy={topY - 1} r="1.5" fill="#fff" />
              <circle className="fm-dot fm-dot-2" cx={CW / 2 - 2} cy={topY - 1} r="1.5" fill="#fff" />
              <circle className="fm-dot fm-dot-3" cx={CW / 2 + 2} cy={topY - 1} r="1.5" fill="#fff" />
            </g>
          ) : (
            <path
              d={`M ${CW / 2 - 5.3} ${topY - 0.7} l 2.4 2.4 l 4.6 -5`}
              fill="none"
              stroke="#fff"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
        </>
      )}
      {runtime.visits.length > 1 && (
        <>
          <circle cx={-CW / 2 + 3} cy={topY - 1} r="8" fill="var(--surface)" stroke="var(--border-strong)" strokeWidth="1" />
          <text x={-CW / 2 + 3} y={topY + 2.5} textAnchor="middle" fontFamily="var(--mono)" fontSize="8.5" fontWeight={700} fill="var(--text-muted)">
            {runtime.visits.length}
          </text>
        </>
      )}

      <foreignObject x={-CW / 2} y={topY} width={CW} height={boxH} style={{ overflow: "visible" }}>
        <div
          style={{
            height: "100%",
            display: "flex",
            flexDirection: "column",
            fontFamily: "var(--font)",
            color: "var(--text)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              flex: trigger ? "0 0 auto" : "1 1 auto",
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              gap: 2,
              padding: trigger ? "9px 11px 8px 15px" : "0 11px 0 15px",
              opacity: state === "pending" ? 0.55 : state === "skipped" ? 0.55 : 1,
            }}
          >
            <div className="row" style={{ gap: 6 }}>
              <span
                className="mono"
                style={{
                  fontSize: 7,
                  fontWeight: 700,
                  letterSpacing: "0.05em",
                  textTransform: "uppercase",
                  padding: "1.5px 4px",
                  borderRadius: 4,
                  lineHeight: 1.3,
                  flex: "none",
                  color: kind === "llm" ? "var(--llm-ink)" : "var(--text-muted)",
                  background: kind === "llm" ? "var(--llm-tint)" : "var(--surface-2)",
                  border: `1px solid ${kind === "llm" ? "var(--llm-border)" : "var(--border)"}`,
                }}
              >
                {kind === "llm" ? "LLM" : "RULE"}
              </span>
              <span
                className="mono"
                style={{ marginLeft: "auto", marginRight: 12, fontSize: 8, color: "var(--tier-priority)", fontWeight: 600, whiteSpace: "nowrap" }}
              >
                {latest && latest.latency_ms > 0
                  ? latest.latency_ms >= 1000
                    ? `${(latest.latency_ms / 1000).toFixed(1)}s`
                    : `${latest.latency_ms}ms`
                  : ""}
              </span>
            </div>
            <span
              style={{
                fontWeight: 600,
                fontSize: 12.5,
                letterSpacing: "-0.006em",
                whiteSpace: "nowrap",
                lineHeight: 1.15,
                textDecoration: state === "skipped" ? "line-through" : undefined,
                textDecorationColor: "var(--text-faint)",
              }}
            >
              {STATION_LABEL[id]}
            </span>
          </div>

          {/* "fires when" — lives INSIDE the card, below a divider, so it
              never collides with the return-to-Notification arc that used
              to run directly underneath it. */}
          {trigger && (
            <div
              style={{
                flex: "1 1 auto",
                display: "flex",
                alignItems: "center",
                padding: "0 11px 0 15px",
                fontFamily: "var(--mono)",
                fontSize: 9.5,
                lineHeight: 1.35,
                color: "var(--text-muted)",
                opacity: state === "pending" ? 0.75 : state === "skipped" ? 0.5 : 0.95,
              }}
            >
              fires when {trigger}
            </div>
          )}
        </div>
      </foreignObject>
    </g>
  );
}

// ── detail panel ───────────────────────────────────────────────────

function DetailPanel({
  jobId,
  shownId,
  station,
  isLive,
  pinned,
  view,
  setView,
  visitIdx,
  setVisitIdx,
  catchingUp,
}: {
  jobId: string | null;
  shownId: StationId | null;
  station: StationRuntime | null;
  isLive: boolean;
  pinned: boolean;
  view: "did" | "role";
  setView: (v: "did" | "role") => void;
  visitIdx: number;
  setVisitIdx: (n: number) => void;
  catchingUp: boolean;
}) {
  if (!jobId || !shownId) {
    return (
      <div className="card" style={{ padding: 15 }}>
        <div className="muted" style={{ fontSize: 13 }}>
          Waiting for a booking. This panel shows exactly what the hovered / active agent decided.
        </div>
      </div>
    );
  }

  const hasRun = station !== null && station.visits.length > 0;
  const effectiveView = hasRun ? view : "role";
  const idx = Math.min(visitIdx, hasRun ? station!.visits.length - 1 : 0);
  const visit = hasRun ? station!.visits[station!.visits.length - 1 - idx] : null;
  const row = visit?.row ?? null;

  return (
    <div className={`card panel ${pinned ? "pinned" : ""}`} style={{ padding: 0, overflow: "hidden", position: "sticky", top: 14 }}>
      <div className="spread" style={{ padding: "12px 15px", borderBottom: "1px solid var(--border)" }}>
        <span className="row" style={{ gap: 8 }}>
          <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: STATION_KIND[shownId] === "llm" ? "var(--llm-ink)" : "var(--text-muted)" }}>
            [{AGENT_TAG[shownId]}]
          </span>
          <span
            className="mono"
            style={{
              fontSize: 8,
              fontWeight: 700,
              letterSpacing: "0.05em",
              textTransform: "uppercase",
              padding: "2px 6px",
              borderRadius: 999,
              color: STATION_KIND[shownId] === "llm" ? "var(--llm-ink)" : "var(--text-muted)",
              background: STATION_KIND[shownId] === "llm" ? "var(--llm-tint)" : "var(--surface-2)",
              border: `1px solid ${STATION_KIND[shownId] === "llm" ? "var(--llm-border)" : "var(--border)"}`,
            }}
          >
            {STATION_KIND[shownId] === "llm" ? "LLM AGENT" : "RULE ENGINE"}
          </span>
        </span>
        {pinned && (
          <span className="mono" style={{ fontSize: 8.5, color: "var(--brand)", letterSpacing: "0.04em", textTransform: "uppercase" }}>
            ● pinned
          </span>
        )}
        {!pinned && row && row.latency_ms > 0 && (
          <span className="mono faint" style={{ fontSize: 10 }}>
            {row.latency_ms.toLocaleString()} ms
          </span>
        )}
      </div>

      <div style={{ padding: 15, maxHeight: 620, overflowY: "auto" }}>
        {hasRun && (
          <div
            className="row"
            style={{ border: "1px solid var(--border)", borderRadius: 7, overflow: "hidden", marginBottom: 13 }}
          >
            <button
              onClick={() => setView("did")}
              style={{
                flex: 1,
                fontWeight: 600,
                fontSize: 10.5,
                padding: "6px 8px",
                border: "none",
                cursor: "pointer",
                background: effectiveView === "did" ? "var(--text)" : "var(--surface)",
                color: effectiveView === "did" ? "var(--surface)" : "var(--text-muted)",
              }}
            >
              {isLive ? "What it is deciding" : "What it decided"}
            </button>
            <button
              onClick={() => setView("role")}
              style={{
                flex: 1,
                fontWeight: 600,
                fontSize: 10.5,
                padding: "6px 8px",
                border: "none",
                borderLeft: "1px solid var(--border)",
                cursor: "pointer",
                background: effectiveView === "role" ? "var(--text)" : "var(--surface)",
                color: effectiveView === "role" ? "var(--surface)" : "var(--text-muted)",
              }}
            >
              Its role
            </button>
          </div>
        )}

        {isLive && (
          <div
            className="row"
            style={{
              gap: 5,
              fontFamily: "var(--mono)",
              fontSize: 8.5,
              fontWeight: 700,
              letterSpacing: "0.05em",
              textTransform: "uppercase",
              color: "var(--tier-priority)",
              background: "var(--tier-priority-bg)",
              border: "1px solid var(--tier-priority)",
              borderRadius: 999,
              padding: "2px 7px",
              width: "fit-content",
              marginBottom: 10,
            }}
          >
            <span style={{ width: 5, height: 5, borderRadius: 999, background: "var(--tier-priority)" }} />
            happening now
          </div>
        )}

        {effectiveView === "did" && row ? (
          <DecidedView row={row} station={shownId} />
        ) : (
          <RoleView station={shownId} />
        )}

        {hasRun && station!.visits.length > 1 && (
          <div className="row" style={{ gap: 6, marginTop: 12, fontSize: 10.5 }}>
            <span className="faint">{station!.visits.length} messages sent from this agent —</span>
            <button
              className="btn"
              style={{ padding: "3px 8px", fontSize: 10.5 }}
              disabled={idx >= station!.visits.length - 1}
              onClick={() => setVisitIdx(idx + 1)}
            >
              ← older
            </button>
            <button className="btn" style={{ padding: "3px 8px", fontSize: 10.5 }} disabled={idx <= 0} onClick={() => setVisitIdx(idx - 1)}>
              newer →
            </button>
          </div>
        )}

        {catchingUp && (
          <div className="mono faint" style={{ fontSize: 10, marginTop: 12 }}>
            catching up to the live feed…
          </div>
        )}
      </div>
    </div>
  );
}

function DecidedView({ row, station }: { row: AgentDecisionLog; station: StationId }) {
  const color = `var(--agent-flow-${STATION_ACCENT[station]})`;
  return (
    <div>
      <p style={{ fontFamily: "var(--font)", fontWeight: 600, fontSize: 14, lineHeight: 1.42, margin: "0 0 12px" }}>{row.headline}</p>

      {row.requires_human_approval && (
        <div
          style={{
            margin: "0 0 12px",
            padding: "11px 12px",
            borderRadius: 7,
            background: "var(--tier-urgent-bg)",
            border: "1px solid rgba(208,52,44,0.32)",
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 12.5, color: "var(--tier-urgent)", marginBottom: 4 }}>■ Needs a coordinator</div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
            The pipeline stopped here and is waiting on <code className="mono">/admin/approvals</code>. Nothing further happens
            automatically.
          </div>
        </div>
      )}

      <KV pairs={summarize(row)} />

      {row.score_breakdown && (
        <div style={{ padding: "12px 0", borderTop: "1px solid var(--border)" }}>
          <ScoreBars b={row.score_breakdown} color={color} />
        </div>
      )}
      {row.candidates && row.candidates.length > 0 && (
        <div style={{ borderTop: "1px solid var(--border)" }}>
          <Candidates rows={row.candidates} />
        </div>
      )}
      {row.replan_options && row.replan_options.length > 0 && (
        <div style={{ borderTop: "1px solid var(--border)" }}>
          <ReplanOptions options={row.replan_options} llmDesigned={row.output_summary?.llm_choice_accepted === true} />
        </div>
      )}

      {row.guardrail_notes.length > 0 && (
        <div style={{ padding: "12px 0 2px", borderTop: "1px solid var(--border)" }}>
          <div className="mono faint" style={{ fontSize: 9.5, letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: 7 }}>
            Guardrails
          </div>
          <ul style={{ margin: 0, paddingLeft: 15 }}>
            {row.guardrail_notes.map((g, i) => (
              <li key={i} style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5, marginBottom: 4 }}>
                {g}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div
        style={{
          fontSize: 11,
          color: "var(--text-muted)",
          lineHeight: 1.5,
          padding: "10px 0 0",
          marginTop: 12,
          borderTop: "1px solid var(--border)",
        }}
      >
        <span className="mono faint" style={{ fontSize: 9, letterSpacing: "0.04em", textTransform: "uppercase", display: "block", marginBottom: 4 }}>
          What this agent is for
        </span>
        {BRIEF[station].role}
      </div>
    </div>
  );
}

function RoleView({ station }: { station: StationId }) {
  const b = BRIEF[station];
  return (
    <div>
      <p style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.55, margin: "0 0 12px" }}>{b.role}</p>
      <div style={{ padding: "12px 0", borderTop: "1px solid var(--border)" }}>
        <div className="mono faint" style={{ fontSize: 9.5, letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: 8 }}>
          What happens inside
        </div>
        <ul style={{ margin: 0, paddingLeft: 15 }}>
          {b.inside.map((x, i) => (
            <li key={i} style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.55, marginBottom: 6 }}>
              {x}
            </li>
          ))}
        </ul>
      </div>
      {station === "assign" && (
        <div style={{ marginTop: 14, padding: "12px 0", borderTop: "1px solid var(--border)" }}>
          <div className="mono faint" style={{ fontSize: 9.5, letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: 8 }}>
            How the score is computed
          </div>
          <ScoringExplainer compact />
        </div>
      )}
      <div style={{ marginTop: 12, padding: "10px 11px", borderRadius: 7, background: "var(--surface-2)", border: "1px solid var(--border)", fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
        {b.guard}
      </div>
    </div>
  );
}

function KV({ pairs }: { pairs: [string, string][] }) {
  if (pairs.length === 0) return null;
  return (
    <dl
      style={{
        display: "grid",
        gridTemplateColumns: "98px 1fr",
        gap: "5px 10px",
        fontSize: 12,
        padding: "10px 0",
        borderTop: "1px solid var(--border)",
      }}
    >
      {pairs.map(([k, v], i) => (
        <Fragment key={`${k}-${i}`}>
          <dt className="mono faint" style={{ fontSize: 10.5 }}>
            {k}
          </dt>
          <dd style={{ margin: 0, color: "var(--text-muted)" }} dangerouslySetInnerHTML={{ __html: v }} />
        </Fragment>
      ))}
    </dl>
  );
}

/** A small, generic key-value summary of a row's structured fields, for
 *  agents without a dedicated visual (score bars / candidates / plans) —
 *  Job-Intake, Pricing, Capacity, Technician-State, Orchestrator,
 *  Notification. Picks a handful of the most legible fields rather than
 *  dumping the whole JSON blob (that's still available via the raw
 *  input/output on PipelineReplay for anyone who wants it). */
function summarize(row: AgentDecisionLog): [string, string][] {
  const out: [string, string][] = [];
  const i = row.input_summary ?? {};
  const o = row.output_summary ?? {};

  function push(label: string, v: unknown, bold = false) {
    if (v === undefined || v === null || v === "") return;
    const text = typeof v === "object" ? JSON.stringify(v) : String(v);
    out.push([label, bold ? `<b>${text}</b>` : text]);
  }

  switch (row.agent_name) {
    case "JobIntakeAgent":
      push("skills", (o as { skill_required?: string[] }).skill_required?.join(", "), true);
      push("urgency", (o as { urgency_hint?: string }).urgency_hint);
      push("window", ((o as { time_window_hours?: [number, number] }).time_window_hours ?? []).join("–") + " h");
      push("injection", (o as { injection_attempt?: boolean }).injection_attempt ? "true — flagged" : "false — clean");
      break;
    case "PricingEngine":
      push("price", `${(o as { price?: number }).price} SGD`, true);
      push("tier", i.tier);
      push("skills", (i as { skill_required?: string[] }).skill_required?.join(", "));
      break;
    case "CapacityAgent":
      push("decision", (o as { decision?: string }).decision, true);
      push("fleet today", `${i.total_today} / ${(i.caps as { total?: number } | undefined)?.total}`);
      break;
    case "TechnicianStateAgent":
      push("candidates", o.candidate_count);
      push("within hours", o.within_hours);
      break;
    case "AssignmentAgent":
      push("assigned", (o as { assigned_technician_id?: string }).assigned_technician_id ?? "none");
      push("eligible", o.eligible_count);
      break;
    case "DisruptionAgent":
      push("bumped job", (i as { bumped_job?: string }).bumped_job);
      push("plans", row.replan_options?.length);
      break;
    case "NotificationAgent":
      push("channel", i.channel, true);
      push("subject", o.subject);
      break;
    case "Orchestrator":
      push("tier", i.tier);
      push("category", i.category);
      push("result", (o as { result?: string }).result);
      break;
    default:
      break;
  }
  return out;
}
