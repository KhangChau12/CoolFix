"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { apiGet } from "@/lib/client";
import { useRealtime } from "@/components/useRealtime";
import { AgentFeed } from "@/components/AgentFeed";
import { Metric, Sparkline } from "@/components/ui";
import {
  estimatedJobMinutes,
  PIPELINE_STAGES,
  TIER_META,
  TIERS,
  type ApprovalRequest,
  type Job,
  type NotificationRecord,
  type Technician,
} from "@/lib/types";
import { hoursBetween, nowISO, sgDayKey, sgHour } from "@/lib/time";

const STAGE_DOT: Record<string, string> = {
  intake: "var(--agent-intake)",
  pricing: "var(--agent-pricing)",
  capacity_check: "var(--agent-capacity)",
  scoring: "var(--agent-assignment)",
  assigned: "var(--border-strong)",
  disruption_review: "var(--agent-disruption)",
  awaiting_approval: "var(--tier-priority)",
  done: "var(--border-strong)",
};

function sgClock(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
}

function sgDate(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore",
    weekday: "short",
    day: "2-digit",
    month: "short",
  }).format(d);
}

function fmtSlot(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

export default function Dashboard() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [techs, setTechs] = useState<Technician[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [clock, setClock] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const [j, t, a, n] = await Promise.all([
        apiGet<{ jobs: Job[] }>("/api/bookings"),
        apiGet<{ technicians: Technician[] }>("/api/technicians"),
        apiGet<{ approvals: ApprovalRequest[] }>("/api/approvals"),
        apiGet<{ notifications: NotificationRecord[] }>("/api/notifications"),
      ]);
      setJobs(j.jobs);
      setTechs(t.technicians);
      setApprovals(a.approvals);
      setNotifications(n.notifications);
    } catch {
      /* keep last good state */
    }
  }, []);

  const conn = useRealtime("jobs", load);
  useRealtime("notifications", load);
  useRealtime("approval_requests", load);
  useEffect(() => {
    load();
  }, [load]);

  // Live SGT clock — hydration-safe (starts null on the server).
  useEffect(() => {
    setClock(new Date(nowISO()));
    const t = setInterval(() => setClock(new Date(nowISO())), 1000);
    return () => clearInterval(t);
  }, []);

  const now = nowISO();
  const nowHour = clock ? sgHour(clock.toISOString()) : null;

  const activeJobs = jobs.filter((j) => j.status !== "completed");
  const todayJobs = jobs.filter((j) => {
    const h = hoursBetween(now, j.scheduled_time);
    return h >= -12 && h <= 24;
  });
  const pendingAssign = jobs.filter((j) => j.status === "pending").length;
  const pendingApprovals = approvals.filter((a) => a.status === "pending").length;
  const frozen = jobs.filter((j) => j.status === "frozen").length;
  const disrupted = jobs.filter((j) => j.status === "disrupted").length;
  const awaitingAck = notifications.filter((n) => !n.acknowledged).length;
  const autoCommitted = jobs.filter((j) =>
    j.reschedule_history.some((r) => r.decided_by === "auto"),
  ).length;

  // ── Fleet load ──────────────────────────────────────────────────
  // "Today" means real Singapore calendar-day, not "every active job ever
  // assigned" — a technician's board can legitimately hold a dozen jobs
  // spread across the coming week (see the seed's 30+ filler jobs) without
  // their actual day being full. Utilisation is real hours committed
  // today (estimatedJobMinutes per job, same figure the Assignment
  // Agent's `availability` scoring component uses) against their own
  // shift length — not a flat headcount against a guessed nominal slot
  // count, which is the exact "workload as a job counter" flaw the
  // scoring engine was rewritten to avoid (see coolfix-scoring-engine).
  const todayKey = sgDayKey(now);
  const fleet = useMemo(() => {
    return techs
      .map((t) => {
        const assigned = activeJobs.filter(
          (j) => j.assigned_technician_id === t.technician_id,
        );
        const todaysJobs = assigned.filter(
          (j) => sgDayKey(j.scheduled_time) === todayKey,
        );
        const upcomingCount = assigned.length;
        const usedMinToday = todaysJobs.reduce(
          (s, j) => s + estimatedJobMinutes(j.skill_required),
          0,
        );
        const [sh, sm] = t.working_hours.start.split(":").map(Number);
        const [eh, em] = t.working_hours.end.split(":").map(Number);
        const shiftMin = Math.max(1, eh * 60 + em - (sh * 60 + sm));
        const nextJob = assigned
          .filter((j) => hoursBetween(now, j.scheduled_time) > -1.5)
          .sort((a, b) => a.scheduled_time.localeCompare(b.scheduled_time))[0];
        const busyNow =
          nowHour !== null &&
          todaysJobs.some((j) => Math.abs(sgHour(j.scheduled_time) - nowHour) < 1.5);
        return {
          id: t.technician_id,
          name: t.name,
          level: t.experience_level,
          todayCount: todaysJobs.length,
          upcomingCount,
          pct: Math.min(100, Math.round((usedMinToday / shiftMin) * 100)),
          busyNow,
          next: nextJob ?? null,
        };
      })
      .sort((a, b) => b.pct - a.pct || a.name.localeCompare(b.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [techs, jobs, nowHour, todayKey]);

  const freeNow = fleet.filter((f) => !f.busyNow).length;
  const fleetUtil = fleet.length
    ? Math.round(fleet.reduce((s, f) => s + f.pct, 0) / fleet.length)
    : 0;

  // ── Throughput by tier (active jobs) ────────────────────────────
  const tierFill = TIERS.map((t) => ({
    tier: t,
    count: activeJobs.filter((j) => j.tier === t).length,
  }));
  const tierTotal = Math.max(
    tierFill.reduce((s, x) => s + x.count, 0),
    1,
  );

  // ── Pipeline funnel ────────────────────────────────────────────
  const pipelineCounts = PIPELINE_STAGES.map((s) => ({
    stage: s.label,
    dot: STAGE_DOT[s.key],
    count: jobs.filter((j) => j.pipeline_stage === s.key).length,
  }));
  const pipelineInFlight = jobs.filter(
    (j) => j.pipeline_stage !== "done" && j.status !== "completed",
  ).length;

  // ── Attention band ─────────────────────────────────────────────
  const jobById = Object.fromEntries(jobs.map((j) => [j.job_id, j]));
  const attentionRows = approvals
    .filter((a) => a.status === "pending")
    .map((a) => ({
      approval_id: a.approval_id,
      kind: a.kind === "emergency_override" ? "EMERGENCY OVERRIDE" : "RE-PLAN APPROVAL",
      customer: jobById[a.job_id]?.customer_name ?? a.job_id,
      reason: a.reason,
      options: a.options.length,
    }));

  const upcomingJobs = jobs
    .filter((j) => hoursBetween(now, j.scheduled_time) > -1 && j.status !== "completed")
    .sort((a, b) => a.scheduled_time.localeCompare(b.scheduled_time))
    .slice(0, 7);

  const connLabel =
    conn === "live" ? "live" : conn === "polling" ? "polling" : "connecting";

  return (
    <div className="stack" style={{ gap: 18 }}>
      {/* ── Command bar ─────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 14,
          padding: "13px 16px",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14, minWidth: 0 }}>
          <div>
            <h1 style={{ fontSize: 19, margin: 0, letterSpacing: "-0.01em" }}>
              Dispatch overview
            </h1>
            <div className="faint" style={{ fontSize: 11.5, marginTop: 2 }}>
              {activeJobs.length} active job{activeJobs.length === 1 ? "" : "s"} ·{" "}
              {techs.length} technicians on roster
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div
            className="row"
            style={{
              gap: 7,
              padding: "5px 10px",
              borderRadius: 999,
              border: "1px solid var(--border)",
              background: "var(--surface-2)",
              fontFamily: "var(--mono)",
              fontSize: 11.5,
            }}
          >
            <span
              className={conn === "live" ? "live-dot" : ""}
              style={{
                width: 7,
                height: 7,
                borderRadius: 999,
                background: conn === "live" ? undefined : "var(--text-faint)",
                flex: "none",
              }}
            />
            <span className="muted">{connLabel}</span>
          </div>
          <div
            className="mono"
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              padding: "5px 10px",
              borderRadius: 999,
              border: "1px solid var(--border)",
              background: "var(--surface-2)",
              minWidth: 148,
              textAlign: "center",
            }}
          >
            {clock ? `${sgDate(clock)} · ${sgClock(clock)}` : "—"} SGT
          </div>
          <Link href="/book" className="btn btn-primary" target="_blank">
            New booking&nbsp;<span aria-hidden style={{ opacity: 0.7 }}>↗</span>
          </Link>
        </div>
      </div>

      {/* ── Attention band (only when something is waiting) ─────── */}
      {attentionRows.length > 0 && (
        <div
          style={{
            border: "1px solid var(--tier-urgent)",
            borderRadius: 12,
            overflow: "hidden",
            background: "var(--tier-urgent-bg)",
            boxShadow: "var(--shadow-sm)",
          }}
        >
          <div
            className="spread"
            style={{
              padding: "10px 15px",
              borderBottom: "1px solid color-mix(in srgb, var(--tier-urgent) 25%, transparent)",
            }}
          >
            <span className="row" style={{ gap: 8 }}>
              <span className="pill-count">{attentionRows.length}</span>
              <strong style={{ fontSize: 13, color: "var(--tier-urgent)", letterSpacing: "0.01em" }}>
                Waiting on a coordinator decision
              </strong>
            </span>
            <Link
              href="/admin/approvals"
              className="row"
              style={{ gap: 4, fontSize: 12, fontWeight: 600 }}
            >
              Open Approvals queue <span aria-hidden>→</span>
            </Link>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
              gap: 1,
              background: "color-mix(in srgb, var(--tier-urgent) 18%, transparent)",
            }}
          >
            {attentionRows.map((r) => (
              <Link
                key={r.approval_id}
                href="/admin/approvals"
                style={{
                  display: "block",
                  padding: "11px 15px",
                  background: "var(--surface)",
                  color: "var(--text)",
                }}
                className="list-row-link"
              >
                <div
                  className="mono"
                  style={{
                    fontSize: 9.5,
                    fontWeight: 700,
                    letterSpacing: "0.04em",
                    color: "var(--tier-urgent)",
                  }}
                >
                  {r.kind}
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, marginTop: 3 }}>{r.customer}</div>
                <div className="muted" style={{ fontSize: 11.5, marginTop: 2, lineHeight: 1.45 }}>
                  {r.reason}
                </div>
                <div className="faint mono" style={{ fontSize: 10, marginTop: 4 }}>
                  {r.options} plan{r.options === 1 ? "" : "s"} to compare →
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* ── KPI strip ──────────────────────────────────────────── */}
      <div
        className="grid"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(158px, 1fr))", gap: 12 }}
      >
        <Metric label="Jobs in the day" value={todayJobs.length} hint="−12h to +24h window" />
        <Metric
          label="Awaiting assignment"
          value={pendingAssign}
          hint={pendingAssign > 0 ? "queued for the pipeline" : "all assigned"}
          accent={pendingAssign > 0 ? "var(--tier-priority)" : undefined}
        />
        <Metric
          label="Needs approval"
          value={pendingApprovals}
          hint={pendingApprovals > 0 ? "in the Approvals queue" : "all clear"}
          accent={pendingApprovals > 0 ? "var(--tier-urgent)" : undefined}
        />
        <Metric
          label="Auto-committed re-plans"
          value={autoCommitted}
          hint="agent moved a job, no human"
          accent={autoCommitted > 0 ? "var(--brand)" : undefined}
        />
        <Metric
          label="Frozen / disrupted"
          value={`${frozen} / ${disrupted}`}
          hint="locked · agent re-planning"
          accent={disrupted > 0 ? "var(--tier-urgent)" : undefined}
        />
        <Metric
          label="Un-acked notifications"
          value={awaitingAck}
          hint={awaitingAck > 0 ? "no 'Seen' from tech / customer" : "all acknowledged"}
          accent={awaitingAck > 0 ? "var(--tier-priority)" : undefined}
        />
      </div>

      {/* ── Ops row: fleet load (wide) · pipeline + tier + next-up ── */}
      <div
        className="grid"
        style={{ gridTemplateColumns: "minmax(0, 1.15fr) minmax(280px, 1fr)", alignItems: "start", gap: 18 }}
      >
        <div className="stack" style={{ gap: 14 }}>
          {/* Fleet load */}
          <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            <div
              className="spread"
              style={{ padding: "12px 15px 11px", borderBottom: "1px solid var(--border)" }}
            >
              <strong style={{ fontSize: 13 }}>Fleet load</strong>
              <span className="row" style={{ gap: 8 }}>
                <span
                  className="mono"
                  style={{
                    fontSize: 11,
                    color: freeNow === 0 ? "var(--tier-urgent)" : "var(--success)",
                  }}
                >
                  {freeNow}/{fleet.length} free now
                </span>
                <Link
                  href="/admin/technicians"
                  className="row"
                  style={{ gap: 3, fontSize: 11.5, fontWeight: 600 }}
                >
                  Roster <span aria-hidden>→</span>
                </Link>
              </span>
            </div>

            <div style={{ padding: "10px 15px 12px" }}>
              <div
                className="spread"
                style={{ fontSize: 11, marginBottom: 9 }}
              >
                <span className="muted" title="Real hours committed today ÷ each technician's shift length, averaged across the roster — not a headcount of every job on their board.">
                  Today&apos;s utilisation
                </span>
                <span className="mono">{fleetUtil}%</span>
              </div>
              <span
                style={{
                  display: "block",
                  height: 6,
                  background: "var(--surface-2)",
                  borderRadius: 999,
                  overflow: "hidden",
                  marginBottom: 14,
                }}
              >
                <span
                  style={{
                    display: "block",
                    height: "100%",
                    width: `${fleetUtil}%`,
                    background:
                      fleetUtil > 80
                        ? "var(--tier-urgent)"
                        : fleetUtil > 55
                          ? "var(--tier-priority)"
                          : "var(--tier-flexible)",
                    borderRadius: 999,
                    transition: "width 0.3s ease",
                  }}
                />
              </span>

              <div style={{ display: "grid", gap: 10 }}>
                {fleet.map((f) => (
                  <div key={f.id} style={{ display: "grid", gap: 4 }}>
                    <div className="spread" style={{ fontSize: 11.5 }}>
                      <span className="row" style={{ gap: 6, minWidth: 0 }}>
                        {f.busyNow && (
                          <span
                            title="on a job right now"
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: 999,
                              background: "var(--status-soon)",
                              flex: "none",
                            }}
                          />
                        )}
                        <span
                          style={{
                            fontWeight: 500,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {f.name}
                        </span>
                        <span className="faint" style={{ fontSize: 9.5 }}>{f.level}</span>
                      </span>
                      <span className="mono faint" style={{ fontSize: 10.5, flexShrink: 0 }}>
                        {f.todayCount === 0 ? "free today" : `${f.pct}% today`}
                      </span>
                    </div>
                    <Sparkline
                      value={Math.max(f.pct, f.todayCount ? 8 : 0)}
                      color={
                        f.pct > 80
                          ? "var(--tier-urgent)"
                          : f.pct > 50
                            ? "var(--tier-priority)"
                            : "var(--tier-standard)"
                      }
                      width="100%"
                      height={5}
                    />
                    <span className="faint mono" style={{ fontSize: 9.5 }}>
                      {f.todayCount} job{f.todayCount === 1 ? "" : "s"} today
                      {f.upcomingCount > f.todayCount && ` · ${f.upcomingCount} on the board this week`}
                      {f.next && ` · next ${fmtSlot(f.next.scheduled_time)} · ${f.next.location.address}`}
                    </span>
                  </div>
                ))}
                {fleet.length === 0 && (
                  <div className="faint" style={{ fontSize: 11.5 }}>Loading roster…</div>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="stack" style={{ gap: 14 }}>
          {/* Pipeline funnel */}
          <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            <div
              className="spread"
              style={{ padding: "12px 15px 11px", borderBottom: "1px solid var(--border)" }}
            >
              <strong style={{ fontSize: 13 }}>Pipeline</strong>
              <span className="faint mono" style={{ fontSize: 10.5 }}>
                {pipelineInFlight} in flight
              </span>
            </div>
            <div style={{ padding: "11px 15px 13px", display: "grid", gap: 7 }}>
              {pipelineCounts.map((p) => (
                <div key={p.stage} className="row" style={{ gap: 9 }}>
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 2,
                      background: p.dot,
                      flexShrink: 0,
                      opacity: p.count > 0 ? 1 : 0.4,
                    }}
                  />
                  <span
                    style={{
                      fontSize: 12,
                      flex: 1,
                      color: p.count > 0 ? "var(--text)" : "var(--text-faint)",
                    }}
                  >
                    {p.stage}
                  </span>
                  <span
                    className="mono"
                    style={{
                      fontSize: 11,
                      color: p.count > 0 ? "var(--text)" : "var(--text-faint)",
                      background: p.count > 0 ? "var(--surface-2)" : "transparent",
                      borderRadius: 999,
                      padding: p.count > 0 ? "1px 8px" : "1px 0",
                      minWidth: 20,
                      textAlign: "center",
                    }}
                  >
                    {p.count}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Tier mix */}
          <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            <div
              style={{ padding: "12px 15px 11px", borderBottom: "1px solid var(--border)" }}
            >
              <strong style={{ fontSize: 13 }}>Active jobs by tier</strong>
            </div>
            <div style={{ padding: "12px 15px 14px" }}>
              <div
                style={{
                  display: "flex",
                  height: 10,
                  borderRadius: 999,
                  overflow: "hidden",
                  background: "var(--surface-2)",
                }}
              >
                {tierFill.map(({ tier, count }) =>
                  count > 0 ? (
                    <span
                      key={tier}
                      title={`${TIER_META[tier].label}: ${count}`}
                      style={{
                        width: `${(count / tierTotal) * 100}%`,
                        background: `var(${TIER_META[tier].colorVar})`,
                        transition: "width 0.3s ease",
                      }}
                    />
                  ) : null,
                )}
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "7px 14px",
                  marginTop: 12,
                }}
              >
                {tierFill.map(({ tier, count }) => (
                  <div key={tier} className="row" style={{ gap: 6, fontSize: 11.5 }}>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 2,
                        background: `var(${TIER_META[tier].colorVar})`,
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ flex: 1 }} className="muted">
                      {TIER_META[tier].label}
                    </span>
                    <span className="mono">{count}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Upcoming */}
          <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            <div
              className="spread"
              style={{ padding: "12px 15px 11px", borderBottom: "1px solid var(--border)" }}
            >
              <strong style={{ fontSize: 13 }}>Next up</strong>
              <Link
                href="/admin/schedule"
                className="row"
                style={{ gap: 3, fontSize: 11.5, fontWeight: 600 }}
              >
                Schedule <span aria-hidden>→</span>
              </Link>
            </div>
            <div style={{ padding: "4px 6px 6px" }}>
              {upcomingJobs.length === 0 && (
                <div className="faint" style={{ fontSize: 11.5, padding: "8px 9px" }}>
                  Nothing on the horizon.
                </div>
              )}
              {upcomingJobs.map((j) => (
                <Link
                  key={j.job_id}
                  href={`/admin/jobs/${j.job_id}`}
                  className="row list-row-link"
                  style={{
                    gap: 9,
                    fontSize: 12,
                    color: "var(--text)",
                    padding: "7px 9px",
                    borderRadius: 7,
                  }}
                >
                  <span className={`status-dot ${j.status}`} />
                  <span
                    style={{
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {j.customer_name}
                  </span>
                  <span
                    style={{
                      fontSize: 8.5,
                      fontWeight: 700,
                      letterSpacing: "0.03em",
                      textTransform: "uppercase",
                      color: `var(${TIER_META[j.tier].colorVar})`,
                    }}
                  >
                    {TIER_META[j.tier].label}
                  </span>
                  <span className="mono faint" style={{ fontSize: 10.5 }}>
                    {fmtSlot(j.scheduled_time)}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Local primitives ─────────────────────────────────────────────

function PanelLabel({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="spread">
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          color: "var(--text-faint)",
        }}
      >
        {title}
      </div>
      {right}
    </div>
  );
}
