"use client";

// ── PipelineReplay ──────────────────────────────────────────────────
// A single job's agent decisions, oldest → newest, as a vertical
// timeline. Same data as AgentFeed but scoped to one job and ordered as
// a replay, so a judge can follow exactly what each agent did for that
// booking. Rows expand to the score bars / candidate list / re-plan
// options / guardrail notes.

import { useCallback, useEffect, useState } from "react";
import { apiGet } from "@/lib/client";
import { useRealtime } from "./useRealtime";
import { ScoreBars, ScoringExplainer } from "./scoring";
import { fmtSGTime } from "@/lib/time";
import type { AgentDecisionLog, AgentName } from "@/lib/types";

const AGENT_META: Record<AgentName, { color: string; short: string }> = {
  PricingEngine: { color: "var(--agent-pricing)", short: "Pricing" },
  JobIntakeAgent: { color: "var(--agent-intake)", short: "Job-Intake" },
  CapacityAgent: { color: "var(--agent-capacity)", short: "Capacity" },
  TechnicianStateAgent: { color: "var(--agent-techstate)", short: "Tech-State" },
  AssignmentAgent: { color: "var(--agent-assignment)", short: "Assignment" },
  AssignmentTiebreakAgent: { color: "var(--agent-assignment)", short: "Tie-break" },
  AssignmentEdgecaseAgent: { color: "var(--agent-disruption)", short: "Edge-case" },
  DisruptionAgent: { color: "var(--agent-disruption)", short: "Disruption" },
  NotificationAgent: { color: "var(--agent-notification)", short: "Notification" },
  Orchestrator: { color: "var(--agent-orchestrator)", short: "Orchestrator" },
};

export function PipelineReplay({ jobId }: { jobId: string }) {
  const [rows, setRows] = useState<AgentDecisionLog[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const { decisions } = await apiGet<{ decisions: AgentDecisionLog[] }>(
        `/api/decisions?job=${encodeURIComponent(jobId)}&limit=200`,
      );
      setRows(decisions);
      setLoaded(true);
    } catch {
      /* keep last */
    }
  }, [jobId]);

  const conn = useRealtime("agent_decision_log", load);
  useEffect(() => {
    load();
  }, [load]);

  function toggle(id: string) {
    setOpen((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  const llmCount = rows.filter((r) => r.reasoning_kind === "llm").length;

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div
        className="spread"
        style={{ padding: "11px 15px", borderBottom: "1px solid var(--border)" }}
      >
        <strong style={{ fontSize: 13.5 }}>
          Pipeline replay · {rows.length} step{rows.length === 1 ? "" : "s"}
        </strong>
        <span className="mono faint" style={{ fontSize: 10.5 }}>
          {llmCount} LLM · {rows.length - llmCount} rule ·{" "}
          {conn === "live" ? "live" : conn === "polling" ? "polling" : "connecting"}
        </span>
      </div>

      <div style={{ padding: "14px 16px" }}>
        {!loaded && (
          <div className="muted" style={{ fontSize: 13, padding: 8 }}>
            Loading…
          </div>
        )}
        {loaded && rows.length === 0 && (
          <div className="muted" style={{ fontSize: 13, padding: 8 }}>
            No agent activity recorded for this job yet.
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column" }}>
          {rows.map((r, i) => {
            const m = AGENT_META[r.agent_name];
            const isOpen = open.has(r.log_id);
            const isLast = i === rows.length - 1;
            return (
              <div key={r.log_id} style={{ display: "flex", gap: 12 }}>
                {/* rail */}
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    flexShrink: 0,
                    width: 22,
                  }}
                >
                  <span
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 999,
                      background: m.color,
                      color: "#26241f",
                      fontSize: 10,
                      fontWeight: 700,
                      fontFamily: "var(--mono)",
                      display: "grid",
                      placeItems: "center",
                      flexShrink: 0,
                    }}
                  >
                    {i + 1}
                  </span>
                  {!isLast && (
                    <span style={{ flex: 1, width: 2, background: "var(--border-strong)", minHeight: 14 }} />
                  )}
                </div>

                {/* card */}
                <div style={{ flex: 1, minWidth: 0, paddingBottom: isLast ? 0 : 14 }}>
                  <button
                    onClick={() => toggle(r.log_id)}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      background: "var(--surface-2)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      cursor: "pointer",
                      padding: "9px 11px",
                    }}
                  >
                    <div className="row" style={{ gap: 7, flexWrap: "wrap" }}>
                      <span
                        className="mono"
                        style={{ fontSize: 10.5, color: m.color, fontWeight: 600 }}
                      >
                        [{m.short.toLowerCase()}]
                      </span>
                      <span
                        style={{
                          fontSize: 8.5,
                          padding: "1px 5px",
                          borderRadius: 999,
                          letterSpacing: "0.03em",
                          background:
                            r.reasoning_kind === "llm" ? "var(--llm-tint)" : "var(--surface-2)",
                          border: `1px solid ${
                            r.reasoning_kind === "llm" ? "var(--llm-border)" : "var(--border)"
                          }`,
                          color:
                            r.reasoning_kind === "llm" ? "var(--llm-ink)" : "var(--text-faint)",
                          fontWeight: 700,
                        }}
                      >
                        {r.reasoning_kind === "llm" ? "LLM AGENT" : "RULE ENGINE"}
                      </span>
                      {r.requires_human_approval && (
                        <span
                          style={{
                            fontSize: 8.5,
                            padding: "1px 5px",
                            borderRadius: 999,
                            background: "var(--tier-urgent)",
                            color: "#fff",
                            fontWeight: 700,
                          }}
                        >
                          NEEDS APPROVAL
                        </span>
                      )}
                      <span className="mono faint" style={{ fontSize: 10, marginLeft: "auto" }}>
                        {fmtSGTime(r.timestamp)}
                        {r.latency_ms > 0 && ` · ${r.latency_ms}ms`}
                        {r.approved_by && ` · by ${r.approved_by}`}
                      </span>
                    </div>
                    <div style={{ fontSize: 12.5, marginTop: 4, lineHeight: 1.5 }}>{r.headline}</div>
                  </button>

                  {isOpen && (
                    <div
                      style={{
                        marginTop: 6,
                        padding: "11px 12px",
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        background: "var(--surface)",
                      }}
                    >
                      {r.score_breakdown && <ScoreBars b={r.score_breakdown} />}
                      {(r.agent_name === "AssignmentAgent" ||
                        r.agent_name === "AssignmentTiebreakAgent") &&
                        r.score_breakdown && (
                          <details style={{ marginTop: 10 }}>
                            <summary
                              className="mono"
                              style={{
                                fontSize: 10.5,
                                color: "var(--text-muted)",
                                cursor: "pointer",
                                letterSpacing: "0.02em",
                              }}
                            >
                              How this score is computed — formula &amp; why each component matters
                            </summary>
                            <div style={{ marginTop: 10 }}>
                              <ScoringExplainer />
                            </div>
                          </details>
                        )}
                      {r.candidates && r.candidates.length > 0 && <Candidates rows={r.candidates} />}
                      {r.replan_options && r.replan_options.length > 0 && (
                        <ReplanOptions
                          options={r.replan_options}
                          llmDesigned={r.output_summary?.llm_choice_accepted === true}
                        />
                      )}
                      {r.guardrail_notes.length > 0 && (
                        <div style={{ marginTop: r.score_breakdown || r.candidates ? 10 : 0 }}>
                          <div
                            className="faint"
                            style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em" }}
                          >
                            Guardrails
                          </div>
                          <ul style={{ margin: "4px 0 0", paddingLeft: 16, fontSize: 11.5, color: "var(--text-muted)" }}>
                            {r.guardrail_notes.map((g, gi) => (
                              <li key={gi}>{g}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      <details style={{ marginTop: 8 }}>
                        <summary className="faint" style={{ fontSize: 10, cursor: "pointer" }}>
                          raw input / output
                        </summary>
                        <pre
                          className="mono"
                          style={{
                            marginTop: 6,
                            padding: 10,
                            background: "var(--surface-2)",
                            border: "1px solid var(--border)",
                            borderRadius: 6,
                            overflowX: "auto",
                            fontSize: 10.5,
                            lineHeight: 1.5,
                            color: "var(--text-muted)",
                          }}
                        >
{JSON.stringify({ input: r.input_summary, output: r.output_summary }, null, 2)}
                        </pre>
                      </details>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── sub-views ──────────────────────────────────────────────────────
// Exported so AgentFlowMap.tsx (the live /admin/flow line map) can reuse
// exactly the same rendering of a decision row's structured payload —
// one definition of what a score breakdown / candidate list / re-plan
// option set looks like, everywhere it's shown.

// ScoreBars / ScoringExplainer / SCORING_COMPONENTS live in ./scoring —
// re-exported here so existing importers (AgentFlowMap) keep working.
export { ScoreBars, ScoringExplainer, SCORING_COMPONENTS } from "./scoring";

export function Candidates({ rows }: { rows: NonNullable<AgentDecisionLog["candidates"]> }) {
  return (
    <div style={{ marginTop: 10 }}>
      <div className="faint" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em" }}>
        Candidates ({rows.filter((r) => r.eligible).length} eligible / {rows.length})
      </div>
      <div style={{ display: "grid", gap: 4, marginTop: 6 }}>
        {rows
          .slice()
          .sort((a, b) => (b.breakdown?.total ?? -1) - (a.breakdown?.total ?? -1))
          .map((c) => (
            <div
              key={c.technician_id}
              className="mono"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 10.5,
                color: "var(--text-muted)",
                opacity: c.eligible ? 1 : 0.6,
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 999,
                  background: c.eligible ? "var(--tier-flexible)" : "var(--tier-urgent)",
                  flex: "none",
                }}
              />
              <span style={{ width: 104, color: "var(--text)" }}>{c.technician_name}</span>
              {c.eligible ? <span>score {c.breakdown?.total}</span> : <span>{c.reject_reason}</span>}
            </div>
          ))}
      </div>
    </div>
  );
}

export function ReplanOptions({
  options,
  llmDesigned,
}: {
  options: NonNullable<AgentDecisionLog["replan_options"]>;
  llmDesigned?: boolean;
}) {
  return (
    <div style={{ marginTop: 10 }}>
      <div className="row" style={{ gap: 8 }}>
        <span className="faint" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em" }}>
          Re-plan options ({options.length})
        </span>
        <span
          style={{
            fontSize: 8.5,
            padding: "1px 6px",
            borderRadius: 999,
            background: llmDesigned ? "var(--llm-tint)" : "var(--surface-2)",
            border: `1px solid ${llmDesigned ? "var(--llm-border)" : "var(--border)"}`,
            color: llmDesigned ? "var(--llm-ink)" : "var(--text-faint)",
            fontWeight: 700,
          }}
        >
          {llmDesigned ? "AI-DESIGNED PLAN" : "MECHANICAL FALLBACK"}
        </span>
      </div>
      <div style={{ display: "grid", gap: 7, marginTop: 7, gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
        {options.map((o) => (
          <div
            key={o.option_id}
            style={{
              padding: "9px 10px",
              borderRadius: 8,
              border: `1px solid ${o.recommended ? "var(--success-border)" : "var(--border)"}`,
              background: o.recommended ? "var(--success-bg)" : "var(--surface-2)",
            }}
          >
            <div style={{ fontSize: 11.5, fontWeight: 600, marginBottom: 3 }}>
              {o.recommended && "★ "}
              {o.label}
            </div>
            {o.plan_rationale && (
              <div style={{ fontSize: 10, fontStyle: "italic", color: "var(--text-muted)", lineHeight: 1.5, marginBottom: 4 }}>
                “{o.plan_rationale}”
              </div>
            )}
            <div style={{ fontSize: 10.5, color: "var(--text-muted)", lineHeight: 1.5 }}>{o.summary}</div>
            <div className="mono faint" style={{ fontSize: 10, marginTop: 5, display: "grid", gap: 1 }}>
              <span>
                {o.trade_offs.customers_affected} customers · +{o.trade_offs.total_added_travel_km}km
              </span>
              <span>
                {o.trade_offs.sla_breaches} SLA · {o.trade_offs.frozen_jobs_touched} frozen
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
