"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiGet, apiSend } from "@/lib/client";
import { useRealtime } from "@/components/useRealtime";
import { EmptyState, Toast } from "@/components/ui";
import MapView, { type MapPin } from "@/components/MapView";
import { fmtSGDateTime } from "@/lib/time";
import type { AgentDecisionLog, ApprovalRequest, Job, Technician } from "@/lib/types";

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const [techs, setTechs] = useState<Record<string, Technician>>({});
  const [decisions, setDecisions] = useState<AgentDecisionLog[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [mapFailed, setMapFailed] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{ msg: string; kind: "success" | "error" } | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, j, t, d] = await Promise.all([
        apiGet<{ approvals: ApprovalRequest[] }>("/api/approvals"),
        apiGet<{ jobs: Job[] }>("/api/bookings"),
        apiGet<{ technicians: Technician[] }>("/api/technicians"),
        apiGet<{ decisions: AgentDecisionLog[] }>("/api/decisions?limit=120"),
      ]);
      setApprovals(a.approvals);
      setJobs(Object.fromEntries(j.jobs.map((x) => [x.job_id, x])));
      setTechs(Object.fromEntries(t.technicians.map((x) => [x.technician_id, x])));
      setDecisions(d.decisions);
    } catch {
      /* keep */
    }
  }, []);

  useRealtime("approval_requests", load);
  useEffect(() => {
    load();
  }, [load]);

  async function resolve(a: ApprovalRequest, decision: "approve" | "reject") {
    setBusy(a.approval_id);
    try {
      const r = await apiSend<{ ok: boolean; message: string }>(
        `/api/approvals/${a.approval_id}/resolve`,
        "POST",
        {
          decision,
          chosenOptionId: choice[a.approval_id],
          coordinatorName: "Coordinator (demo)",
        },
      );
      setToast({ msg: r.message, kind: r.ok ? "success" : "error" });
      await load();
    } catch (e) {
      setToast({ msg: (e as Error).message, kind: "error" });
    } finally {
      setBusy(null);
    }
  }

  const pending = approvals.filter((a) => a.status === "pending");
  const resolved = approvals.filter((a) => a.status !== "pending");

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div>
        <h1 style={{ fontSize: 22, margin: 0 }}>Approvals — Human in the Loop</h1>
        <p className="muted" style={{ margin: "2px 0 0", fontSize: 13 }}>
          The Disruption Agent stops here when a re-plan affects a customer or touches a
          frozen job. You choose the plan and approve, or reject to keep everything as-is.
        </p>
      </div>

      {pending.length === 0 && (
        <EmptyState>
          No approvals pending. When an urgent booking forces a reschedule, it appears here.
        </EmptyState>
      )}

      {pending.map((a) => {
        const job = jobs[a.job_id];
        const selected = choice[a.approval_id] ?? a.options.find((o) => o.recommended)?.option_id;
        const isEmergency = a.kind === "emergency_override";
        const levelColor = isEmergency ? "var(--tier-urgent)" : "var(--agent-disruption)";
        const disruptionRow = decisions.find((d) => d.log_id === a.disruption_log_id);

        // Map the geography of this decision: the incoming job that forced the
        // re-plan (anchor) plus every OTHER job the selected plan would move,
        // each tagged with the technician who'd take it.
        const selectedOpt =
          a.options.find((o) => o.option_id === selected) ??
          a.options.find((o) => o.recommended) ??
          a.options[0];
        const extraPins: MapPin[] = (selectedOpt?.moves ?? [])
          .map((mv): MapPin | null => {
            const mj = jobs[mv.job_id];
            if (!mj) return null;
            const t = techs[mv.technician_id];
            return {
              lat: mj.location.lat,
              lng: mj.location.lng,
              role: "alt",
              label: `${mj.customer_name} → moved${t ? ` · ${t.name}` : ""}`,
            };
          })
          .filter((x): x is MapPin => x !== null);

        return (
          <div
            key={a.approval_id}
            className="card"
            style={{
              padding: "16px 18px",
              borderLeft: `4px solid ${levelColor}`,
            }}
          >
            <div className="row" style={{ gap: 10, flexWrap: "wrap", marginBottom: 9 }}>
              <span
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 10.5,
                  letterSpacing: "0.04em",
                  color: "#fff",
                  background: levelColor,
                  borderRadius: 4,
                  padding: "3px 7px",
                }}
              >
                {isEmergency ? "LEVEL 2 · OVERRIDE" : "LEVEL 1 · RE-PLAN"}
              </span>
              <span className="muted" style={{ fontSize: 11.5 }}>{a.reason}</span>
              <span className="mono faint" style={{ marginLeft: "auto", fontSize: 10.5 }}>
                {fmtSGDateTime(a.created_at)}
              </span>
            </div>

            {job && (
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 5 }}>
                {job.customer_name} · {job.location.address}
              </div>
            )}
            <div style={{ fontSize: 12.5, color: "#3c3a4a", lineHeight: 1.6, marginBottom: 11 }}>
              {job
                ? `${job.tier} · needs ${job.skill_required.join(", ")}`
                : `Job ${a.job_id}`}
              {isEmergency && a.frozen_jobs_impacted.length > 0 &&
                ` — frozen jobs impacted: ${a.frozen_jobs_impacted.join(", ")}`}
            </div>

            {job && !mapFailed.has(a.approval_id) && (
              <div style={{ marginBottom: 12 }}>
                <MapView
                  mode="display"
                  customer={{ lat: job.location.lat, lng: job.location.lng, address: job.location.address }}
                  extras={extraPins}
                  height={200}
                  onUnavailable={() => setMapFailed((s) => new Set(s).add(a.approval_id))}
                />
                <p className="faint" style={{ fontSize: 10.5, margin: "5px 0 0" }}>
                  🔵 incoming urgent job
                  {extraPins.length > 0 && " · 🟢 jobs this plan would move"}
                </p>
              </div>
            )}

            {disruptionRow && a.options.length > 0 && (
              <AgentReasoningPanel row={disruptionRow} jobId={a.job_id} />
            )}

            {a.options.length === 0 ? (
              <div
                style={{
                  padding: "11px 12px",
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  background: "var(--surface-2)",
                  fontSize: 12.5,
                  color: "#3c3a4a",
                  lineHeight: 1.6,
                  marginBottom: 13,
                }}
              >
                <strong style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--agent-disruption)" }}>
                  Edge-case proposal
                </strong>
                <div style={{ marginTop: 5 }}>{a.reason}</div>
                <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                  Approving records that you will run this dispatch by hand — nothing on the
                  schedule is moved automatically.
                </div>
              </div>
            ) : (
              <>
            <div className="faint" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>
              Choose a re-plan
            </div>
            <div
              className="grid"
              style={{ gridTemplateColumns: `repeat(auto-fit, minmax(220px, 1fr))`, gap: 10, marginBottom: 13 }}
            >
              {a.options.map((o) => (
                <label
                  key={o.option_id}
                  style={{
                    padding: 12,
                    borderRadius: 8,
                    cursor: "pointer",
                    border: `1px solid ${selected === o.option_id ? "var(--brand)" : "var(--border)"}`,
                    background: selected === o.option_id ? "var(--brand-tint)" : "var(--surface-2)",
                  }}
                >
                  <div className="row" style={{ gap: 6 }}>
                    <input
                      type="radio"
                      name={`opt-${a.approval_id}`}
                      checked={selected === o.option_id}
                      onChange={() => setChoice((c) => ({ ...c, [a.approval_id]: o.option_id }))}
                    />
                    <strong style={{ fontSize: 12 }}>{o.label}</strong>
                    {o.recommended && (
                      <span className="chip" style={{ fontSize: 9, marginLeft: "auto", background: "var(--brand)", color: "#fff", borderColor: "transparent" }}>
                        ★ agent pick
                      </span>
                    )}
                  </div>
                  {o.plan_rationale && (
                    <div
                      style={{
                        marginTop: 6,
                        fontSize: 11,
                        fontStyle: "italic",
                        color: "#514f5d",
                        lineHeight: 1.6,
                      }}
                    >
                      “{o.plan_rationale}”
                    </div>
                  )}
                  <div
                    className="mono"
                    style={{
                      marginTop: 8,
                      background: "#fff",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      padding: "9px 10px",
                      fontSize: 11,
                      color: "#3c3a4a",
                      lineHeight: 1.7,
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {o.summary}
                    {o.moves.length > 0 &&
                      "\n" +
                        o.moves
                          .map((mv) => `${mv.customer_name}: ${fmtSGDateTime(mv.from_time)} → ${fmtSGDateTime(mv.to_time)}`)
                          .join("\n")}
                  </div>
                  <div className="mono faint" style={{ fontSize: 10, marginTop: 8, display: "grid", gap: 1 }}>
                    <span>{o.trade_offs.customers_affected} customers affected · +{o.trade_offs.total_added_travel_km} km</span>
                    <span>{o.trade_offs.sla_breaches} SLA breach · {o.trade_offs.frozen_jobs_touched} frozen touched</span>
                    {(o.trade_offs.total_shift_hours != null || o.trade_offs.tightest_gap_hours != null) && (
                      <span>
                        {o.trade_offs.total_shift_hours != null && `shifted ${o.trade_offs.total_shift_hours}h`}
                        {o.trade_offs.tightest_gap_hours != null && (
                          <span style={{ color: o.trade_offs.tightest_gap_hours < 2 ? "var(--tier-urgent)" : undefined }}>
                            {" · "}{o.trade_offs.tightest_gap_hours}h gap to next job{o.trade_offs.tightest_gap_hours < 2 ? " ⚠ tight" : ""}
                          </span>
                        )}
                      </span>
                    )}
                  </div>
                </label>
              ))}
            </div>
              </>
            )}

            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <button
                className="btn btn-approve btn-lg"
                disabled={busy === a.approval_id}
                onClick={() => resolve(a, "approve")}
              >
                {busy === a.approval_id ? "Working…" : isEmergency ? "Approve Override" : "Approve"}
              </button>
              <button
                className="btn btn-lg"
                disabled={busy === a.approval_id}
                onClick={() => resolve(a, "reject")}
              >
                Reject
              </button>
              {isEmergency && (
                <span className="muted" style={{ fontSize: 11 }}>
                  Approving is logged with your name — it changes a locked appointment.
                </span>
              )}
            </div>
          </div>
        );
      })}

      {resolved.length > 0 && (
        <div className="card" style={{ padding: 16 }}>
          <strong style={{ fontSize: 13 }}>Recently resolved</strong>
          <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
            {resolved.slice(0, 8).map((a) => (
              <div key={a.approval_id} className="row" style={{ gap: 8, fontSize: 12 }}>
                <span
                  className="chip"
                  style={{
                    fontSize: 9,
                    background: a.status === "approved" ? "var(--tier-flexible-bg)" : "var(--tier-urgent-bg)",
                    color: a.status === "approved" ? "var(--tier-flexible)" : "var(--tier-urgent)",
                  }}
                >
                  {a.status.toUpperCase()}
                </span>
                <span className="mono faint">{a.approval_id}</span>
                <span className="muted">
                  {a.kind === "emergency_override" ? "Emergency Override" : "Re-plan"} ·{" "}
                  {a.resolved_by ?? "—"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {toast && <Toast message={toast.msg} kind={toast.kind} onClose={() => setToast(null)} />}
    </div>
  );
}

// ── How the agent decided ──────────────────────────────────────────
// Surfaces, on the approval card itself, what the Disruption Agent's log
// row already records: whether the LLM designed the plan or we fell back
// to the mechanical option, whether the rule layer re-ranked the LLM's
// stated preference, and why any candidate plan was thrown out on
// re-validation. Without this the coordinator only sees the final option
// list and has to open the feed to learn how it was chosen.

function AgentReasoningPanel({
  row,
  jobId,
}: {
  row: AgentDecisionLog;
  jobId: string;
}) {
  const llmDesigned = row.output_summary?.llm_choice_accepted === true;
  const notes = row.guardrail_notes ?? [];

  // Classify the notes the pipeline writes (disruption.ts `rejectionNotes`).
  const reranked = notes.filter((n) =>
    /stated preference scored worse|lower-cost plan is recommended/i.test(n),
  );
  const rejected = notes.filter((n) =>
    /rejected on re-validation|failed the plan-space cross-check|no LLM plan survived/i.test(n),
  );
  const fellBack = notes.some((n) => /best mechanical option instead|Fell back to the best/i.test(n));

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--surface-2)",
        padding: "10px 12px",
        marginBottom: 12,
      }}
    >
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <span
          className="faint"
          style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em" }}
        >
          How the agent decided
        </span>
        <span
          style={{
            fontSize: 8.5,
            padding: "1px 6px",
            borderRadius: 999,
            fontWeight: 700,
            background: llmDesigned ? "var(--llm-tint)" : "var(--surface)",
            border: `1px solid ${llmDesigned ? "var(--llm-border)" : "var(--border)"}`,
            color: llmDesigned ? "var(--llm-ink)" : "var(--text-faint)",
          }}
        >
          {llmDesigned ? "LLM-DESIGNED PLAN" : "MECHANICAL FALLBACK"}
        </span>
        <Link href={`/admin/jobs/${jobId}`} style={{ fontSize: 10.5, marginLeft: "auto" }}>
          full pipeline →
        </Link>
      </div>

      <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.55, marginTop: 6 }}>
        {llmDesigned ? (
          <>
            The LLM composed the re-plan inside the legal slot space; the rule
            layer then re-scored every plan on the shared cost formula (SLA
            breach &gt; tight squeeze &gt; customers moved &gt; time shift &gt;
            travel) and the ★ option below is the objective winner.
          </>
        ) : (
          <>
            No LLM plan survived validation — the ★ option below is the best
            pre-computed mechanical re-plan, with every hard constraint still
            enforced.
          </>
        )}
      </div>

      {reranked.length > 0 && (
        <div
          style={{
            marginTop: 7,
            fontSize: 11,
            color: "var(--llm-ink)",
            background: "var(--llm-tint)",
            border: "1px solid var(--llm-border)",
            borderRadius: 6,
            padding: "6px 8px",
          }}
        >
          ⚖ Rule overrode the LLM: {reranked.join(" ")}
        </div>
      )}

      {(rejected.length > 0 || fellBack) && (
        <div style={{ marginTop: 7 }}>
          <div className="faint" style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.04em" }}>
            Plans thrown out
          </div>
          <ul style={{ margin: "3px 0 0", paddingLeft: 15, fontSize: 10.5, color: "var(--text-muted)" }}>
            {rejected.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
            {fellBack && rejected.length === 0 && (
              <li>The LLM&apos;s plan(s) failed re-validation — fell back to the mechanical option.</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
