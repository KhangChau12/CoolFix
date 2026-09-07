"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet } from "@/lib/client";
import { useRealtime } from "./useRealtime";
import { fmtSGTime } from "@/lib/time";
import type { AgentDecisionLog, AgentName } from "@/lib/types";

const AGENT_META: Record<AgentName, { icon: string; color: string; short: string }> = {
  PricingEngine: { icon: "$", color: "var(--agent-pricing)", short: "Pricing" },
  JobIntakeAgent: { icon: "⌕", color: "var(--agent-intake)", short: "Job-Intake" },
  CapacityAgent: { icon: "▦", color: "var(--agent-capacity)", short: "Capacity" },
  TechnicianStateAgent: { icon: "⚉", color: "var(--agent-techstate)", short: "Tech-State" },
  AssignmentAgent: { icon: "⊕", color: "var(--agent-assignment)", short: "Assignment" },
  DisruptionAgent: { icon: "⚡", color: "var(--agent-disruption)", short: "Disruption" },
  NotificationAgent: { icon: "✉", color: "var(--agent-notification)", short: "Notification" },
  Orchestrator: { icon: "◆", color: "var(--agent-orchestrator)", short: "Orchestrator" },
};

export function AgentFeed({ limit = 60, jobId }: { limit?: number; jobId?: string }) {
  const [rows, setRows] = useState<AgentDecisionLog[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const { decisions } = await apiGet<{ decisions: AgentDecisionLog[] }>(
        `/api/decisions?limit=${limit}`,
      );
      setRows(jobId ? decisions.filter((d) => d.job_id === jobId) : decisions);
      setLoaded(true);
    } catch {
      /* keep last */
    }
  }, [limit, jobId]);

  const conn = useRealtime("agent_decision_log", load);
  useEffect(() => {
    load();
  }, [load]);

  function toggle(id: string) {
    setExpanded((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        background: "var(--ink-3)",
        border: "1px solid var(--ink-border)",
        borderRadius: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "11px 15px",
          borderBottom: "1px solid var(--ink-border)",
        }}
      >
        <span className="row" style={{ gap: 9 }}>
          <span
            className={conn === "live" ? "live-dot" : ""}
            style={{
              width: 7,
              height: 7,
              borderRadius: 999,
              background: conn === "live" ? undefined : "var(--ink-text-faint)",
            }}
          />
          <strong style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink-text)" }}>
            Agent reasoning · {conn === "live" ? "live" : conn === "polling" ? "polling" : "connecting"}
          </strong>
        </span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink-text-faint)" }}>
          click a line to expand the scoring
        </span>
      </div>

      <div style={{ overflowY: "auto", maxHeight: 600, padding: "10px 11px", display: "flex", flexDirection: "column", gap: 7 }}>
        {!loaded && (
          <div style={{ padding: 20, fontSize: 13, color: "var(--ink-text-muted)" }}>Loading feed…</div>
        )}
        {loaded && rows.length === 0 && (
          <div style={{ padding: 24, fontSize: 13, color: "var(--ink-text-muted)" }}>
            No agent activity yet. Submit a booking from the Customer form to see the pipeline run.
          </div>
        )}
        {rows.map((r) => {
          const m = AGENT_META[r.agent_name];
          const isOpen = expanded.has(r.log_id);
          return (
            <div
              key={r.log_id}
              style={{
                background: "var(--ink-2)",
                border: "1px solid var(--ink-border)",
                borderRadius: 8,
                animation: "slideIn 0.25s ease",
              }}
            >
              <button
                onClick={() => toggle(r.log_id)}
                style={{
                  width: "100%",
                  textAlign: "left",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: "10px 12px",
                  display: "flex",
                  gap: 9,
                  alignItems: "flex-start",
                  fontFamily: "var(--mono)",
                  fontSize: 11.5,
                  lineHeight: 1.65,
                  color: "var(--ink-text-muted)",
                }}
              >
                <span style={{ color: m.color, flexShrink: 0 }}>[{m.short.toLowerCase()}]</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ color: "var(--ink-text)" }}>{r.headline}</span>
                  <br />
                  <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", marginTop: 3 }}>
                    <span
                      style={{
                        fontSize: 9,
                        padding: "1px 5px",
                        borderRadius: 999,
                        background: r.reasoning_kind === "llm" ? "var(--llm-tint)" : "var(--ink-border)",
                        color: r.reasoning_kind === "llm" ? "var(--llm-ink)" : "var(--ink-text-faint)",
                      }}
                    >
                      {r.reasoning_kind.toUpperCase()}
                    </span>
                    {r.requires_human_approval && (
                      <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 999, background: "var(--tier-urgent)", color: "#fff" }}>
                        NEEDS APPROVAL
                      </span>
                    )}
                    <span style={{ color: "var(--ink-text-faint)" }}>
                      {r.job_id}
                      {r.latency_ms > 0 && ` · ${r.latency_ms}ms`}
                      {r.approved_by && ` · by ${r.approved_by}`}
                    </span>
                  </span>
                </span>
                <span style={{ color: "var(--ink-text-faint)", flexShrink: 0 }}>{fmtSGTime(r.timestamp)}</span>
              </button>

              {isOpen && (
                <div style={{ borderTop: "1px solid var(--ink-border)", padding: "12px 14px 14px" }}>
                  {r.score_breakdown && <ScoreBars b={r.score_breakdown} color={m.color} />}
                  {r.candidates && r.candidates.length > 0 && <Candidates rows={r.candidates} />}
                  {r.replan_options && r.replan_options.length > 0 && (
                    <ReplanOptions options={r.replan_options} />
                  )}

                  {r.guardrail_notes.length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--ink-text-faint)" }}>
                        Guardrails
                      </div>
                      <ul style={{ margin: "4px 0 0", paddingLeft: 16, color: "var(--ink-text-muted)", fontSize: 11.5 }}>
                        {r.guardrail_notes.map((g, i) => (
                          <li key={i}>{g}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <details style={{ marginTop: 8 }}>
                    <summary style={{ fontSize: 10, cursor: "pointer", color: "var(--ink-text-faint)" }}>
                      raw input / output
                    </summary>
                    <pre
                      style={{
                        marginTop: 6,
                        padding: 10,
                        background: "var(--ink)",
                        border: "1px solid var(--ink-border)",
                        borderRadius: 6,
                        overflowX: "auto",
                        fontSize: 10.5,
                        lineHeight: 1.5,
                        fontFamily: "var(--mono)",
                        color: "var(--ink-text-muted)",
                      }}
                    >
{JSON.stringify({ input: r.input_summary, output: r.output_summary }, null, 2)}
                    </pre>
                  </details>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ScoreBars({ b, color }: { b: NonNullable<AgentDecisionLog["score_breakdown"]>; color: string }) {
  const parts: [string, number][] = [
    ["distance", b.distance],
    ["skill match", b.skill_match],
    ["urgency", b.urgency],
    ["workload", b.workload],
  ];
  const max = Math.max(...parts.map((p) => p[1]), 0.001);
  return (
    <div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink-text-faint)", marginBottom: 10 }}>
        score = w1·(1/distance) + w2·skill_match + w3·urgency + w4·(1/workload)
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {parts.map(([label, v]) => (
          <div key={label} style={{ display: "grid", gridTemplateColumns: "88px minmax(0,1fr) 60px", alignItems: "center", gap: 10 }}>
            <div style={{ fontSize: 11.5, color: "var(--ink-text-muted)" }}>{label}</div>
            <div style={{ height: 7, background: "var(--ink-border)", borderRadius: 4, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${(v / max) * 100}%`, background: color, borderRadius: 4 }} />
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink-text)", textAlign: "right" }}>{v}</div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, paddingTop: 10, borderTop: "1px dashed var(--ink-border)", fontFamily: "var(--mono)" }}>
        <span style={{ fontSize: 11, color: "var(--ink-text-faint)" }}>weighted score</span>
        <span style={{ fontSize: 16, fontWeight: 600, color: "var(--ink-text)" }}>{b.total}</span>
      </div>
    </div>
  );
}

function Candidates({ rows }: { rows: NonNullable<AgentDecisionLog["candidates"]> }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--ink-text-faint)" }}>
        Candidates ({rows.filter((r) => r.eligible).length} eligible / {rows.length})
      </div>
      <div style={{ display: "grid", gap: 5, marginTop: 8 }}>
        {rows
          .slice()
          .sort((a, b) => (b.breakdown?.total ?? -1) - (a.breakdown?.total ?? -1))
          .map((c) => (
            <div
              key={c.technician_id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 11,
                fontFamily: "var(--mono)",
                color: "var(--ink-text-muted)",
                opacity: c.eligible ? 1 : 0.55,
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: 999, background: c.eligible ? "var(--tier-flexible)" : "var(--tier-urgent)", flex: "none" }} />
              <span style={{ width: 110, color: "var(--ink-text)" }}>{c.technician_name}</span>
              {c.eligible ? (
                <span>score {c.breakdown?.total}</span>
              ) : (
                <span>{c.reject_reason}</span>
              )}
            </div>
          ))}
      </div>
    </div>
  );
}

function ReplanOptions({ options }: { options: NonNullable<AgentDecisionLog["replan_options"]> }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--ink-text-faint)" }}>
        Re-plan options ({options.length})
      </div>
      <div
        style={{
          display: "grid",
          gap: 8,
          marginTop: 8,
          gridTemplateColumns: `repeat(auto-fit, minmax(190px, 1fr))`,
        }}
      >
        {options.map((o) => (
          <div
            key={o.option_id}
            style={{
              padding: "11px 12px",
              borderRadius: 8,
              border: `1px solid ${o.recommended ? "#3f6f4a" : "var(--ink-border)"}`,
              background: o.recommended ? "#17251b" : "#191713",
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-text)", marginBottom: 4 }}>
              {o.recommended && "★ "}{o.label}
            </div>
            <div style={{ fontSize: 11, color: "var(--ink-text-muted)", lineHeight: 1.5 }}>{o.summary}</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink-text-faint)", marginTop: 7, display: "grid", gap: 1 }}>
              <span>{o.trade_offs.customers_affected} customers · +{o.trade_offs.total_added_travel_km}km</span>
              <span>{o.trade_offs.sla_breaches} SLA · {o.trade_offs.frozen_jobs_touched} frozen</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
