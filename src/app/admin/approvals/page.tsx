"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiSend } from "@/lib/client";
import { useRealtime } from "@/components/useRealtime";
import { EmptyState, Toast } from "@/components/ui";
import { fmtSGDateTime } from "@/lib/time";
import type { ApprovalRequest, Job } from "@/lib/types";

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<{ msg: string; kind: "success" | "error" } | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, j] = await Promise.all([
        apiGet<{ approvals: ApprovalRequest[] }>("/api/approvals"),
        apiGet<{ jobs: Job[] }>("/api/bookings"),
      ]);
      setApprovals(a.approvals);
      setJobs(Object.fromEntries(j.jobs.map((x) => [x.job_id, x])));
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
            <div style={{ fontSize: 12.5, color: "#4a4741", lineHeight: 1.6, marginBottom: 11 }}>
              {job
                ? `${job.tier} · needs ${job.skill_required.join(", ")}`
                : `Job ${a.job_id}`}
              {isEmergency && a.frozen_jobs_impacted.length > 0 &&
                ` — frozen jobs impacted: ${a.frozen_jobs_impacted.join(", ")}`}
            </div>

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
                  <div
                    className="mono"
                    style={{
                      marginTop: 8,
                      background: "#fff",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      padding: "9px 10px",
                      fontSize: 11,
                      color: "#4a4741",
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
                  </div>
                </label>
              ))}
            </div>

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
