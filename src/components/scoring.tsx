"use client";

// ── Shared scoring UI ──────────────────────────────────────────────
// One definition of how the Assignment Agent's score is drawn and
// explained, reused by the job replay (PipelineReplay), the live Agent
// Flow Map, the dashboard feed and the Settings screen. Keeping it here
// (no data-fetching imports) means a page can show the explainer without
// pulling in the whole replay component.

import type { AgentDecisionLog, ScoreComponent } from "@/lib/types";

// ── Shared per-component color palette ──────────────────────────────
// One color per scoring component, used everywhere a breakdown is drawn
// (score bars, the component explainer, Settings' policy sliders) so the
// same idea always reads as the same color — travel is always this blue,
// skill-fit always this green, etc. Distinct from the tier/status palette
// on purpose: these are literal hex values, not CSS tokens, because they
// need to read consistently on both the dark AgentFeed panel and light
// cards, and neither tokenised palette is built for 5 flat swatches.
export const SCORE_COMPONENT_COLOR: Record<ScoreComponent, string> = {
  travel: "#3d68b0",
  skillFit: "#6b8e23",
  availability: "#c98a3c",
  slaHeadroom: "#b0453b",
  loadBalance: "#5a7d9a",
  customerSatisfaction: "#c2703d",
};

const BAR_PARTS: [ScoreComponent, string][] = [
  ["travel", "travel fit"],
  ["skillFit", "skill fit"],
  ["availability", "availability"],
  ["slaHeadroom", "SLA headroom"],
  ["loadBalance", "load balance"],
  ["customerSatisfaction", "customer satisfaction"],
];
const BAR_KEY: Record<ScoreComponent, keyof NonNullable<AgentDecisionLog["score_breakdown"]>> = {
  travel: "travel",
  skillFit: "skill_fit",
  availability: "availability",
  slaHeadroom: "sla_headroom",
  loadBalance: "load_balance",
  customerSatisfaction: "customer_satisfaction",
};

// ── The score, component by component, as bars ─────────────────────
// Each bar takes its own component color (SCORE_COMPONENT_COLOR) instead
// of one flat color for the whole breakdown — the point is to tell the
// five ideas apart at a glance, not to tint them all the same as the
// agent that produced them.

export function ScoreBars({
  b,
}: {
  b: NonNullable<AgentDecisionLog["score_breakdown"]>;
}) {
  const total = b.total || 0.001;
  return (
    <div>
      <div className="mono faint" style={{ fontSize: 10, marginBottom: 8 }}>
        match = Σ policy[tier][k] · component[k] · each component ∈ [0,1], weights sum to 1
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {BAR_PARTS.map(([key, label]) => {
          // customer_satisfaction is optional — rows logged before this
          // component existed don't have it. Treat missing as 0 rather
          // than crashing on `.toFixed`.
          const v = (b[BAR_KEY[key]] as number | undefined) ?? 0;
          return (
            <div
              key={key}
              style={{ display: "grid", gridTemplateColumns: "82px minmax(0,1fr) 52px", alignItems: "center", gap: 9 }}
            >
              <div className="row" style={{ gap: 6, fontSize: 11, color: "var(--text-muted)" }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: SCORE_COMPONENT_COLOR[key], flexShrink: 0 }} />
                {label}
              </div>
              <div style={{ height: 6, background: "var(--surface-2)", borderRadius: 4, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${(v / total) * 100}%`, background: SCORE_COMPONENT_COLOR[key], borderRadius: 4 }} />
              </div>
              <div className="mono" style={{ fontSize: 10, textAlign: "right" }}>{v.toFixed(2)}</div>
            </div>
          );
        })}
      </div>
      <div
        className="spread"
        style={{ marginTop: 9, paddingTop: 8, borderTop: "1px dashed var(--border-strong)" }}
      >
        <span className="faint" style={{ fontSize: 11 }}>match score</span>
        <span className="mono" style={{ fontSize: 15, fontWeight: 700 }}>{Math.round(b.total * 100)}%</span>
      </div>
      {b.raw && (
        <div className="faint" style={{ fontSize: 10, marginTop: 7 }}>
          +{b.raw.detour_min} min detour · {b.raw.util_pct}% of shift used
          {b.raw.hours_to_deadline != null && ` · ${b.raw.hours_to_deadline}h to SLA deadline`}
        </div>
      )}
    </div>
  );
}

// ── Formula + why each component matters ───────────────────────────
// This is the panel you want on screen when a judge asks "how does it
// actually decide?". Shown on the Assignment station of the Agent Flow
// Map, above the score bars in the job replay, and in Settings.

export const SCORING_COMPONENTS: {
  key: ScoreComponent;
  label: string;
  weightNote: string;
  measures: string;
  why: string;
}[] = [
  {
    key: "travel",
    label: "Travel fit",
    weightNote: "pool-normalised",
    measures:
      "The extra driving time this job adds to the technician's route today — the detour between the job before it and the job after it, not the distance from their home base.",
    why: "Straight-line distance from a depot is the wrong thing to optimise. A dispatch desk cares about the marginal cost of slotting a job into an existing run: a job on the way costs almost nothing, a job that doubles back costs a wasted hour and a late arrival for the next customer.",
  },
  {
    key: "skillFit",
    label: "Skill fit",
    weightNote: "absolute [0,1]",
    measures:
      "Certification is already a hard filter, so this scores the right seniority for the job's complexity (a chiller plant or a multi-skill visit wants a senior; routine servicing does not) minus a small penalty for sending an over-qualified technician to easy work.",
    why: "First-time-fix rate and callback rate track seniority-for-complexity, not seniority in the abstract. Burning your one senior chiller tech on a filter clean is how you miss the commercial SLA in the afternoon.",
  },
  {
    key: "availability",
    label: "Availability",
    weightNote: "pool-normalised",
    measures:
      "Hours left in the technician's shift after this job, from real estimated job durations — a 45-minute clean and a 3-hour chiller job are not the same 'one job'.",
    why: "A head-count of jobs hides overtime risk and cascading delays. Measuring the actual hours committed is what lets the system protect a technician's day and keep promised arrival windows.",
  },
  {
    key: "slaHeadroom",
    label: "SLA headroom",
    weightNote: "absolute [0,1]",
    measures:
      "How close the job is to its tier deadline (urgent 24h, priority 72h, …). Any technician whose schedule would push the job past that deadline scores 0 here.",
    why: "A flat 'urgency weight' is the same for every candidate, so it never changes who gets picked. Deadline pressure is real and it should both raise a job's priority as time runs out and disqualify anyone who can't actually make the date.",
  },
  {
    key: "loadBalance",
    label: "Load balance",
    weightNote: "absolute [0,1]",
    measures:
      "Pulls work toward technicians who are below the fleet's median utilisation for the day.",
    why: "Left alone, a pure travel + skill score piles every job onto the two people nearest the city centre while others idle. Balancing utilisation keeps the roster sustainable and gives you slack for the next urgent call.",
  },
  {
    key: "customerSatisfaction",
    label: "Customer satisfaction",
    weightNote: "absolute [0,1] · small default weight",
    measures:
      "Bayesian-smoothed historical rating from past customer feedback (1-5★, minimum-sample smoothed toward a neutral prior so one review can't swing it). A technician with no ratings yet scores at that same neutral prior — never 0, never penalised for being new.",
    why: "A soft tie-breaker only, by design: it runs after every hard constraint (skill, hours, no double-booking, route feasibility) has already filtered the pool, and its weight defaults to a conservative 5% everywhere. It can nudge which of several qualified technicians gets the job; it can never make an unqualified one win.",
  },
];

export function ScoringExplainer({ compact = false }: { compact?: boolean }) {
  return (
    <div>
      <div
        className="mono"
        style={{
          fontSize: compact ? 10.5 : 11.5,
          lineHeight: 1.5,
          padding: compact ? "8px 10px" : "10px 12px",
          borderRadius: 7,
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
          marginBottom: 12,
        }}
      >
        match(tech, job) ={" "}
        <span style={{ color: "var(--text-muted)" }}>
          Σ<sub>k</sub> policy[tier][k] · component<sub>k</sub>(tech, job)
        </span>
        <div style={{ marginTop: 5, color: "var(--text-faint)", fontSize: compact ? 9.5 : 10.5 }}>
          k ∈ {"{"} travel, skillFit, availability, slaHeadroom, loadBalance,
          customerSatisfaction {"}"} · each component ∈ [0,1] · Σ policy[tier] = 1 → match ∈ [0,1]
        </div>
        <div style={{ marginTop: 4, color: "var(--text-faint)", fontSize: compact ? 9.5 : 10.5 }}>
          travel &amp; availability are min-max ranked <em>within the candidate pool</em>, so
          they always separate candidates — never a constant offset.
        </div>
      </div>
      <div className="mono faint" style={{ fontSize: 9.5, letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: 8 }}>
        Why each component matters
      </div>
      <div style={{ display: "grid", gap: 10 }}>
        {SCORING_COMPONENTS.map((c) => {
          const color = SCORE_COMPONENT_COLOR[c.key];
          return (
            <div
              key={c.key}
              style={{
                padding: "10px 12px",
                borderRadius: 8,
                background: `color-mix(in srgb, ${color} 6%, var(--surface))`,
                borderLeft: `3px solid ${color}`,
              }}
            >
              <div className="row" style={{ gap: 8, alignItems: "baseline", marginBottom: 2 }}>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: color, flexShrink: 0 }} />
                <strong style={{ fontSize: 12, color }}>{c.label}</strong>
                <span className="mono faint" style={{ fontSize: 9.5 }}>
                  {c.weightNote}
                </span>
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
                {c.measures}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  lineHeight: 1.5,
                  marginTop: 5,
                  paddingTop: 5,
                  borderTop: `1px dashed color-mix(in srgb, ${color} 35%, var(--border))`,
                }}
              >
                <span className="faint" style={{ fontSize: 10 }}>Why it matters — </span>
                {c.why}
              </div>
            </div>
          );
        })}
      </div>
      <div
        style={{
          fontSize: 10.5,
          color: "var(--text-faint)",
          lineHeight: 1.5,
          marginTop: 12,
          paddingTop: 10,
          borderTop: "1px solid var(--border)",
        }}
      >
        The per-tier weights (dispatch policy) are the business lever — urgent leans on
        travel and skill, flexible leans on load balance. Editable in Settings; the score
        stays readable as a 0–100% match either way.
      </div>
    </div>
  );
}
