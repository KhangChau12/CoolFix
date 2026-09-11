"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { apiGet } from "@/lib/client";
import { useRealtime } from "./useRealtime";
import { fmtSGTime } from "@/lib/time";
import { TIER_META } from "@/lib/types";
import type { AgentDecisionLog, AgentName, Job, Tier } from "@/lib/types";

const AGENT_META: Record<AgentName, { icon: string; color: string; short: string }> = {
  PricingEngine: { icon: "$", color: "var(--agent-pricing)", short: "Pricing" },
  JobIntakeAgent: { icon: "⌕", color: "var(--agent-intake)", short: "Job-Intake" },
  CapacityAgent: { icon: "▦", color: "var(--agent-capacity)", short: "Capacity" },
  TechnicianStateAgent: { icon: "⚉", color: "var(--agent-techstate)", short: "Tech-State" },
  AssignmentAgent: { icon: "⊕", color: "var(--agent-assignment)", short: "Assignment" },
  AssignmentTiebreakAgent: { icon: "⚖", color: "var(--agent-assignment)", short: "Tie-break" },
  AssignmentEdgecaseAgent: { icon: "⊗", color: "var(--agent-disruption)", short: "Edge-case" },
  DisruptionAgent: { icon: "⚡", color: "var(--agent-disruption)", short: "Disruption" },
  NotificationAgent: { icon: "✉", color: "var(--agent-notification)", short: "Notification" },
  Orchestrator: { icon: "◆", color: "var(--agent-orchestrator)", short: "Orchestrator" },
};

/** Reliable per-run ordering key: log_id ends in `_<base36 monotonic seq>`. */
function seqOf(id: string): number {
  const n = parseInt(id.split("_").pop() ?? "0", 36);
  return Number.isFinite(n) ? n : 0;
}

interface JobGroup {
  jobId: string;
  rows: AgentDecisionLog[];
  first: AgentDecisionLog;
  last: AgentDecisionLog;
  llmCount: number;
  needsApproval: boolean;
  customer: string | null;
  tier: Tier | null;
  status: string | null;
}

export function AgentFeed({ limit = 60 }: { limit?: number }) {
  const [rows, setRows] = useState<AgentDecisionLog[]>([]);
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [collapsedJobs, setCollapsedJobs] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const [{ decisions }, jobsRes] = await Promise.all([
        apiGet<{ decisions: AgentDecisionLog[] }>(`/api/decisions?limit=${limit}`),
        apiGet<{ jobs: Job[] }>("/api/bookings").catch(() => ({ jobs: [] as Job[] })),
      ]);
      setRows(decisions);
      setJobs(Object.fromEntries(jobsRes.jobs.map((j) => [j.job_id, j])));
      setLoaded(true);
    } catch {
      /* keep last */
    }
  }, [limit]);

  const conn = useRealtime("agent_decision_log", load);
  useEffect(() => {
    load();
  }, [load]);

  function toggleRow(id: string) {
    setExpandedRows((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  function toggleJob(id: string) {
    setCollapsedJobs((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  // Group decision rows by job. Each group is ordered oldest → newest
  // (pipeline order); groups are ordered by most-recent activity first so
  // the booking you just submitted sits at the top.
  const groups = useMemo<JobGroup[]>(() => {
    const byJob = new Map<string, AgentDecisionLog[]>();
    for (const r of rows) {
      const arr = byJob.get(r.job_id) ?? [];
      arr.push(r);
      byJob.set(r.job_id, arr);
    }
    const out: JobGroup[] = [];
    for (const [jid, arr] of byJob) {
      arr.sort(
        (a, b) => a.timestamp.localeCompare(b.timestamp) || seqOf(a.log_id) - seqOf(b.log_id),
      );
      const job = jobs[jid];
      // Fall back to the Orchestrator "New booking received" row for tier if
      // the job record isn't loaded (e.g. wiped between runs).
      const intakeRow = arr.find((r) => r.agent_name === "Orchestrator");
      const tierFromLog = (intakeRow?.input_summary?.tier as Tier | undefined) ?? null;
      out.push({
        jobId: jid,
        rows: arr,
        first: arr[0],
        last: arr[arr.length - 1],
        llmCount: arr.filter((r) => r.reasoning_kind === "llm").length,
        needsApproval: arr.some((r) => r.requires_human_approval),
        customer: job?.customer_name ?? null,
        tier: job?.tier ?? tierFromLog,
        status: job?.status ?? null,
      });
    }
    out.sort((a, b) => b.last.timestamp.localeCompare(a.last.timestamp) || seqOf(b.last.log_id) - seqOf(a.last.log_id));
    return out;
  }, [rows, jobs]);

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
        <span className="row" style={{ gap: 10, flexWrap: "wrap" }}>
          <span className="row" style={{ gap: 5 }}>
            <span
              style={{
                fontSize: 8,
                fontWeight: 700,
                letterSpacing: "0.03em",
                padding: "1px 5px",
                borderRadius: 999,
                background: "var(--llm-tint)",
                color: "var(--llm-ink)",
              }}
            >
              LLM AGENT
            </span>
            <span style={{ fontSize: 9.5, color: "var(--ink-text-faint)" }}>judgement calls</span>
          </span>
          <span className="row" style={{ gap: 5 }}>
            <span
              style={{
                fontSize: 8,
                fontWeight: 700,
                letterSpacing: "0.03em",
                padding: "1px 5px",
                borderRadius: 999,
                background: "var(--ink-border)",
                color: "var(--ink-text-faint)",
              }}
            >
              RULE ENGINE
            </span>
            <span style={{ fontSize: 9.5, color: "var(--ink-text-faint)" }}>
              deterministic — pricing, capacity, scoring
            </span>
          </span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink-text-faint)" }}>
            {groups.length} booking{groups.length === 1 ? "" : "s"} · click to expand
          </span>
        </span>
      </div>

      <div
        style={{
          overflowY: "auto",
          maxHeight: 600,
          padding: "10px 11px",
          display: "flex",
          flexDirection: "column",
          gap: 9,
        }}
      >
        {!loaded && (
          <div style={{ padding: 20, fontSize: 13, color: "var(--ink-text-muted)" }}>Loading feed…</div>
        )}
        {loaded && groups.length === 0 && (
          <div style={{ padding: 24, fontSize: 13, color: "var(--ink-text-muted)" }}>
            No agent activity yet. Submit a booking from the Customer form to see the pipeline run.
          </div>
        )}

        {groups.map((g) => {
          const open = !collapsedJobs.has(g.jobId);
          const tierMeta = g.tier ? TIER_META[g.tier] : null;
          return (
            <div
              key={g.jobId}
              style={{
                background: "var(--ink-2)",
                border: `1px solid ${g.needsApproval ? "var(--tier-urgent)" : "var(--ink-border)"}`,
                borderRadius: 10,
                animation: "slideIn 0.25s ease",
                overflow: "hidden",
              }}
            >
              {/* job header */}
              <button
                onClick={() => toggleJob(g.jobId)}
                style={{
                  width: "100%",
                  textAlign: "left",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: "11px 13px",
                  display: "flex",
                  gap: 10,
                  alignItems: "flex-start",
                }}
              >
                <span
                  style={{
                    color: "var(--ink-text-faint)",
                    fontFamily: "var(--mono)",
                    fontSize: 11,
                    marginTop: 1,
                    flexShrink: 0,
                    transform: open ? "rotate(90deg)" : "none",
                    transition: "transform 0.15s",
                  }}
                >
                  ▶
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="row" style={{ gap: 7, flexWrap: "wrap" }}>
                    {tierMeta && (
                      <span
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: 999,
                          background: `var(${tierMeta.colorVar})`,
                          flexShrink: 0,
                        }}
                      />
                    )}
                    <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-text)" }}>
                      {g.customer ?? g.jobId}
                    </span>
                    {tierMeta && (
                      <span
                        style={{
                          fontSize: 9,
                          padding: "1px 5px",
                          borderRadius: 999,
                          background: "var(--ink-border)",
                          color: "var(--ink-text-muted)",
                        }}
                      >
                        {tierMeta.label}
                      </span>
                    )}
                    {g.needsApproval && (
                      <span
                        style={{
                          fontSize: 9,
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
                  </span>
                  <span
                    className="mono"
                    style={{
                      display: "block",
                      fontSize: 10.5,
                      color: "var(--ink-text-muted)",
                      marginTop: 4,
                      lineHeight: 1.5,
                    }}
                  >
                    {g.last.headline}
                  </span>
                  <span
                    style={{
                      display: "inline-flex",
                      gap: 8,
                      flexWrap: "wrap",
                      marginTop: 4,
                      fontFamily: "var(--mono)",
                      fontSize: 9.5,
                      color: "var(--ink-text-faint)",
                    }}
                  >
                    <span>{g.rows.length} steps</span>
                    <span>{g.llmCount} LLM · {g.rows.length - g.llmCount} rule</span>
                    <span>{g.jobId}</span>
                    <span>{fmtSGTime(g.last.timestamp)}</span>
                  </span>
                </span>
              </button>

              {/* per-agent rows */}
              {open && (
                <div
                  style={{
                    borderTop: "1px solid var(--ink-border)",
                    padding: "8px 9px 9px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 5,
                  }}
                >
                  {g.rows.map((r, i) => {
                    const m = AGENT_META[r.agent_name];
                    const isOpen = expandedRows.has(r.log_id);
                    return (
                      <div
                        key={r.log_id}
                        style={{
                          background: "var(--ink-3)",
                          border: "1px solid var(--ink-border)",
                          borderRadius: 7,
                        }}
                      >
                        <button
                          onClick={() => toggleRow(r.log_id)}
                          style={{
                            width: "100%",
                            textAlign: "left",
                            background: "none",
                            border: "none",
                            cursor: "pointer",
                            padding: "8px 10px",
                            display: "flex",
                            gap: 9,
                            alignItems: "flex-start",
                            fontFamily: "var(--mono)",
                            fontSize: 11,
                            lineHeight: 1.6,
                            color: "var(--ink-text-muted)",
                          }}
                        >
                          <span style={{ color: "var(--ink-text-faint)", flexShrink: 0, width: 14 }}>
                            {i + 1}.
                          </span>
                          <span style={{ color: m.color, flexShrink: 0 }}>[{m.short.toLowerCase()}]</span>
                          <span style={{ flex: 1, minWidth: 0 }}>
                            <span style={{ color: "var(--ink-text)" }}>{r.headline}</span>
                            <br />
                            <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", marginTop: 3 }}>
                              <span
                                style={{
                                  fontSize: 8.5,
                                  padding: "1px 5px",
                                  borderRadius: 999,
                                  fontWeight: 700,
                                  letterSpacing: "0.03em",
                                  background:
                                    r.reasoning_kind === "llm" ? "var(--llm-tint)" : "var(--ink-border)",
                                  color:
                                    r.reasoning_kind === "llm" ? "var(--llm-ink)" : "var(--ink-text-faint)",
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
                                  }}
                                >
                                  NEEDS APPROVAL
                                </span>
                              )}
                              <span style={{ color: "var(--ink-text-faint)" }}>
                                {r.latency_ms > 0 && `${r.latency_ms}ms`}
                                {r.approved_by && ` · by ${r.approved_by}`}
                              </span>
                            </span>
                          </span>
                          <span style={{ color: "var(--ink-text-faint)", flexShrink: 0 }}>
                            {fmtSGTime(r.timestamp)}
                          </span>
                        </button>

                        {isOpen && (
                          <div style={{ borderTop: "1px solid var(--ink-border)", padding: "11px 13px 13px" }}>
                            {r.score_breakdown && <ScoreBars b={r.score_breakdown} color={m.color} />}
                            {r.candidates && r.candidates.length > 0 && <Candidates rows={r.candidates} />}
                            {r.replan_options && r.replan_options.length > 0 && (
                              <ReplanOptions
                                options={r.replan_options}
                                llmDesigned={r.output_summary?.llm_choice_accepted === true}
                              />
                            )}

                            {r.guardrail_notes.length > 0 && (
                              <div style={{ marginTop: 8 }}>
                                <div
                                  style={{
                                    fontSize: 10,
                                    textTransform: "uppercase",
                                    letterSpacing: "0.04em",
                                    color: "var(--ink-text-faint)",
                                  }}
                                >
                                  Guardrails
                                </div>
                                <ul
                                  style={{
                                    margin: "4px 0 0",
                                    paddingLeft: 16,
                                    color: "var(--ink-text-muted)",
                                    fontSize: 11,
                                  }}
                                >
                                  {r.guardrail_notes.map((gn, gi) => (
                                    <li key={gi}>{gn}</li>
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
                                  fontSize: 10,
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

                  <Link
                    href={`/admin/jobs/${g.jobId}`}
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: 10,
                      color: "var(--ink-text-faint)",
                      padding: "3px 4px",
                    }}
                  >
                    open full job view →
                  </Link>
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
    ["travel fit", b.travel],
    ["skill fit", b.skill_fit],
    ["availability", b.availability],
    ["SLA headroom", b.sla_headroom],
    ["load balance", b.load_balance],
  ];
  const total = b.total || 0.001;
  return (
    <div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink-text-faint)", marginBottom: 10 }}>
        match = Σ policy[tier][k] · component[k] &nbsp;·&nbsp; each component ∈ [0,1], weights sum to 1
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {parts.map(([label, v]) => (
          <div key={label} style={{ display: "grid", gridTemplateColumns: "88px minmax(0,1fr) 60px", alignItems: "center", gap: 10 }}>
            <div style={{ fontSize: 11.5, color: "var(--ink-text-muted)" }}>{label}</div>
            <div style={{ height: 7, background: "var(--ink-border)", borderRadius: 4, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${(v / total) * 100}%`, background: color, borderRadius: 4 }} />
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink-text)", textAlign: "right" }}>{v.toFixed(2)}</div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, paddingTop: 10, borderTop: "1px dashed var(--ink-border)", fontFamily: "var(--mono)" }}>
        <span style={{ fontSize: 11, color: "var(--ink-text-faint)" }}>match score</span>
        <span style={{ fontSize: 16, fontWeight: 600, color: "var(--ink-text)" }}>{Math.round(b.total * 100)}%</span>
      </div>
      {b.raw && (
        <div style={{ marginTop: 8, fontSize: 10.5, color: "var(--ink-text-faint)" }}>
          +{b.raw.detour_min} min detour · {b.raw.util_pct}% of shift used
          {b.raw.hours_to_deadline != null && ` · ${b.raw.hours_to_deadline}h to SLA deadline`}
        </div>
      )}
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

function ReplanOptions({
  options,
  llmDesigned,
}: {
  options: NonNullable<AgentDecisionLog["replan_options"]>;
  llmDesigned?: boolean;
}) {
  return (
    <div style={{ marginTop: 12 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--ink-text-faint)",
        }}
      >
        <span>Re-plan options ({options.length})</span>
        <span
          style={{
            fontSize: 9,
            padding: "1px 6px",
            borderRadius: 999,
            letterSpacing: "0.03em",
            background: llmDesigned ? "var(--llm-tint)" : "var(--ink-border)",
            color: llmDesigned ? "var(--llm-ink)" : "var(--ink-text-faint)",
          }}
        >
          {llmDesigned ? "AI-DESIGNED PLAN" : "MECHANICAL FALLBACK"}
        </span>
      </div>
      <div
        style={{
          display: "grid",
          gap: 8,
          marginTop: 8,
          gridTemplateColumns: `repeat(auto-fit, minmax(200px, 1fr))`,
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
            {o.plan_rationale && (
              <div
                style={{
                  fontSize: 10.5,
                  fontStyle: "italic",
                  color: "var(--ink-text-muted)",
                  lineHeight: 1.5,
                  marginBottom: 5,
                }}
              >
                “{o.plan_rationale}”
              </div>
            )}
            <div style={{ fontSize: 11, color: "var(--ink-text-muted)", lineHeight: 1.5 }}>{o.summary}</div>
            {o.moves.length > 0 && (
              <div
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 10,
                  color: "var(--ink-text-faint)",
                  marginTop: 6,
                  display: "grid",
                  gap: 1,
                }}
              >
                {o.moves.map((mv, i) => (
                  <span key={i}>
                    {mv.customer_name}: {fmtSGTime(mv.from_time)} → {fmtSGTime(mv.to_time)}
                  </span>
                ))}
              </div>
            )}
            <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--ink-text-faint)", marginTop: 7, display: "grid", gap: 1 }}>
              <span>{o.trade_offs.customers_affected} customers · +{o.trade_offs.total_added_travel_km}km</span>
              <span>{o.trade_offs.sla_breaches} SLA · {o.trade_offs.frozen_jobs_touched} frozen</span>
              {(o.trade_offs.total_shift_hours != null || o.trade_offs.tightest_gap_hours != null) && (
                <span>
                  {o.trade_offs.total_shift_hours != null && `shifted ${o.trade_offs.total_shift_hours}h`}
                  {o.trade_offs.tightest_gap_hours != null && (
                    <span style={{ color: o.trade_offs.tightest_gap_hours < 2 ? "var(--tier-urgent)" : undefined }}>
                      {" · "}{o.trade_offs.tightest_gap_hours}h gap{o.trade_offs.tightest_gap_hours < 2 ? " ⚠" : ""}
                    </span>
                  )}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
