"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiGet } from "@/lib/client";
import { useRealtime } from "@/components/useRealtime";
import { AgentFeed } from "@/components/AgentFeed";
import { Metric } from "@/components/ui";
import {
  PIPELINE_STAGES,
  TIER_META,
  TIERS,
  type ApprovalRequest,
  type Job,
  type NotificationRecord,
} from "@/lib/types";
import { hoursBetween, nowISO } from "@/lib/time";

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

export default function Dashboard() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);

  const load = useCallback(async () => {
    try {
      const [j, a, n] = await Promise.all([
        apiGet<{ jobs: Job[] }>("/api/bookings"),
        apiGet<{ approvals: ApprovalRequest[] }>("/api/approvals"),
        apiGet<{ notifications: NotificationRecord[] }>("/api/notifications"),
      ]);
      setJobs(j.jobs);
      setApprovals(a.approvals);
      setNotifications(n.notifications);
    } catch {
      /* keep */
    }
  }, []);

  useRealtime("jobs", load);
  useRealtime("notifications", load);
  useEffect(() => {
    load();
  }, [load]);

  const now = nowISO();
  const todayJobs = jobs.filter((j) => {
    const h = hoursBetween(now, j.scheduled_time);
    return h >= -12 && h <= 24;
  });
  const pendingAssign = jobs.filter((j) => j.status === "pending").length;
  const pendingApprovals = approvals.filter((a) => a.status === "pending").length;
  const frozen = jobs.filter((j) => j.status === "frozen").length;
  const awaitingAck = notifications.filter((n) => !n.acknowledged).length;

  const tierFill = TIERS.map((t) => ({
    tier: t,
    count: jobs.filter((j) => j.tier === t && j.status !== "completed").length,
  }));
  const maxTier = Math.max(...tierFill.map((x) => x.count), 1);

  const jobById = Object.fromEntries(jobs.map((j) => [j.job_id, j]));
  const pendingApprovalRows = approvals
    .filter((a) => a.status === "pending")
    .map((a) => ({
      approval_id: a.approval_id,
      reason: a.kind === "emergency_override" ? "EMERGENCY OVERRIDE" : "RE-PLAN APPROVAL",
      title: jobById[a.job_id]
        ? `${jobById[a.job_id].customer_name} · ${a.reason}`
        : a.reason,
    }));

  const pipelineCounts = PIPELINE_STAGES.map((s) => ({
    stage: s.label,
    dot: STAGE_DOT[s.key],
    count: jobs.filter((j) => j.pipeline_stage === s.key).length,
  }));

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="spread">
        <div>
          <h1 style={{ fontSize: 22, margin: 0 }}>Dashboard</h1>
          <p className="muted" style={{ margin: "2px 0 0", fontSize: 13 }}>
            Live view of the dispatch pipeline and agent decisions.
          </p>
        </div>
        <Link href="/book" className="btn btn-primary" target="_blank">
          + New booking (Customer form)
        </Link>
      </div>

      <div
        className="grid"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}
      >
        <Metric label="Jobs in the day" value={todayJobs.length} hint="−12h to +24h window" />
        <Metric
          label="Awaiting assignment"
          value={pendingAssign}
          accent={pendingAssign > 0 ? "var(--tier-priority)" : undefined}
        />
        <Metric
          label="Needs approval"
          value={pendingApprovals}
          accent={pendingApprovals > 0 ? "var(--tier-urgent)" : undefined}
          hint={pendingApprovals > 0 ? "Go to Approvals (HITL)" : "all clear"}
        />
        <Metric label="Frozen (locked)" value={frozen} accent="var(--status-frozen)" />
        <Metric
          label="Notifications un-acked"
          value={awaitingAck}
          accent={awaitingAck > 0 ? "var(--tier-priority)" : undefined}
          hint={awaitingAck > 0 ? "technician / customer hasn't tapped Seen" : "all acknowledged"}
        />
      </div>

      <div className="grid" style={{ gridTemplateColumns: "1.4fr 1fr", alignItems: "start", gap: 20 }}>
        <AgentFeed limit={80} />

        <div className="stack" style={{ gap: 16 }}>
          <div className="card" style={{ padding: 16 }}>
            <strong style={{ fontSize: 13 }}>Fill by tier</strong>
            <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
              {tierFill.map(({ tier, count }) => (
                <div key={tier} className="row" style={{ gap: 8 }}>
                  <span style={{ width: 92, fontSize: 12 }}>
                    {TIER_META[tier].emoji} {TIER_META[tier].label}
                  </span>
                  <span style={{ flex: 1, height: 10, background: "var(--surface-2)", borderRadius: 999 }}>
                    <span
                      style={{
                        display: "block",
                        height: "100%",
                        width: `${(count / maxTier) * 100}%`,
                        background: `var(${TIER_META[tier].colorVar})`,
                        borderRadius: 999,
                      }}
                    />
                  </span>
                  <span className="mono" style={{ width: 22, textAlign: "right" }}>{count}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card" style={{ padding: 16 }}>
            <div className="spread" style={{ marginBottom: 10 }}>
              <strong style={{ fontSize: 13.5 }}>Waiting on you</strong>
              <Link href="/admin/approvals" style={{ fontSize: 12 }}>
                Open queue
              </Link>
            </div>
            {pendingApprovalRows.length === 0 && (
              <div className="faint" style={{ fontSize: 12 }}>Nothing pending.</div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {pendingApprovalRows.slice(0, 2).map((h) => (
                <div key={h.approval_id} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "10px 11px" }}>
                  <div className="mono faint" style={{ fontSize: 11, marginBottom: 3 }}>{h.reason}</div>
                  <div style={{ fontSize: 12.5, fontWeight: 500, lineHeight: 1.45 }}>{h.title}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="card" style={{ padding: 16 }}>
            <strong style={{ fontSize: 13.5, display: "block", marginBottom: 10 }}>Pipeline</strong>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {pipelineCounts.map((p) => (
                <div key={p.stage} className="row" style={{ gap: 10 }}>
                  <span style={{ width: 9, height: 9, borderRadius: 3, background: p.dot, display: "inline-block", flexShrink: 0 }} />
                  <span style={{ fontSize: 12.5, flex: 1 }}>{p.stage}</span>
                  <span className="mono" style={{ fontSize: 12, color: "var(--text-muted)" }}>{p.count}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card" style={{ padding: 16 }}>
            <strong style={{ fontSize: 13 }}>Upcoming (next 6)</strong>
            <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
              {jobs
                .filter((j) => hoursBetween(now, j.scheduled_time) > -1 && j.status !== "completed")
                .sort((a, b) => a.scheduled_time.localeCompare(b.scheduled_time))
                .slice(0, 6)
                .map((j) => (
                  <Link
                    key={j.job_id}
                    href={`/admin/jobs/${j.job_id}`}
                    className="row"
                    style={{ gap: 8, fontSize: 12, color: "var(--text)" }}
                  >
                    <span className={`status-dot ${j.status}`} />
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {j.customer_name}
                    </span>
                    <span className="chip" style={{ fontSize: 9 }}>{TIER_META[j.tier].label}</span>
                    <span className="mono faint">
                      {new Intl.DateTimeFormat("en-GB", {
                        timeZone: "Asia/Singapore",
                        weekday: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                        hour12: false,
                      }).format(new Date(j.scheduled_time))}
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
