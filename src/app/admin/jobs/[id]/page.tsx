"use client";

// ── Admin · one job, end to end ─────────────────────────────────────
// The "pipeline replay" view: everything the agents did for a single
// booking, plus the notification acknowledgements it produced (so the
// coordinator can see the loop closed — technician / customer tapped
// "Seen").

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiGet } from "@/lib/client";
import { useRealtime } from "@/components/useRealtime";
import { PipelineReplay } from "@/components/PipelineReplay";
import { TierBadge, StatusDot } from "@/components/ui";
import { fmtSGDateTime } from "@/lib/time";
import type { Job, NotificationRecord, Technician } from "@/lib/types";

export default function AdminJobPage({ params }: { params: { id: string } }) {
  const jobId = params.id;
  const [job, setJob] = useState<Job | null>(null);
  const [tech, setTech] = useState<Technician | null>(null);
  const [notes, setNotes] = useState<NotificationRecord[]>([]);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    try {
      const [{ job, technician }, { notifications }] = await Promise.all([
        apiGet<{ job: Job; technician: Technician | null }>(`/api/jobs/${jobId}`),
        apiGet<{ notifications: NotificationRecord[] }>(
          `/api/notifications?job=${encodeURIComponent(jobId)}`,
        ),
      ]);
      setJob(job);
      setTech(technician);
      setNotes(
        notifications
          .slice()
          .sort((a, b) => a.created_at.localeCompare(b.created_at)),
      );
    } catch {
      setNotFound(true);
    }
  }, [jobId]);

  useRealtime("jobs", load);
  useRealtime("notifications", load);
  useEffect(() => {
    load();
  }, [load]);

  if (notFound) {
    return (
      <div className="stack" style={{ gap: 12 }}>
        <Link href="/admin/queue" style={{ fontSize: 12 }}>← Job queue</Link>
        <div className="card" style={{ padding: 24 }}>Job {jobId} not found.</div>
      </div>
    );
  }

  const acked = notes.filter((n) => n.acknowledged).length;

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div>
        <Link href="/admin/queue" style={{ fontSize: 12 }}>← Job queue</Link>
        <h1 style={{ fontSize: 22, margin: "6px 0 0" }}>
          {job ? job.customer_name : jobId}
        </h1>
        <p className="muted" style={{ margin: "2px 0 0", fontSize: 13 }}>
          Every agent decision for this booking, in order — and whether the
          people it notified have acknowledged.
        </p>
      </div>

      {job && (
        <div className="card" style={{ padding: 16 }}>
          <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
            <TierBadge tier={job.tier} />
            <StatusDot status={job.status} label />
            <span className="mono faint" style={{ fontSize: 11, marginLeft: "auto" }}>{job.job_id}</span>
          </div>
          <dl
            style={{
              fontSize: 12.5,
              display: "grid",
              gridTemplateColumns: "130px 1fr",
              gap: "5px 12px",
              margin: "12px 0 0",
            }}
          >
            <dt className="muted">Address</dt>
            <dd style={{ margin: 0 }}>{job.location.address}</dd>
            <dt className="muted">Needs</dt>
            <dd style={{ margin: 0 }}>{job.skill_required.join(", ")}</dd>
            <dt className="muted">Scheduled</dt>
            <dd style={{ margin: 0 }}>{fmtSGDateTime(job.scheduled_time)} SGT</dd>
            <dt className="muted">Technician</dt>
            <dd style={{ margin: 0 }}>
              {tech ? `${tech.name} · ${tech.experience_level}` : "— not assigned"}
            </dd>
            <dt className="muted">Price</dt>
            <dd style={{ margin: 0 }}>{job.price} SGD</dd>
            {job.reschedule_history.length > 0 && (
              <>
                <dt className="muted">Rescheduled</dt>
                <dd style={{ margin: 0 }}>
                  {job.reschedule_history.length}× — last by{" "}
                  {job.reschedule_history.at(-1)?.decided_by} (
                  {job.reschedule_history.at(-1)?.reason})
                </dd>
              </>
            )}
          </dl>
        </div>
      )}

      <PipelineReplay jobId={jobId} />

      <div className="card" style={{ padding: 16 }}>
        <div className="spread" style={{ marginBottom: 10 }}>
          <strong style={{ fontSize: 13.5 }}>Notifications</strong>
          <span className="mono faint" style={{ fontSize: 11 }}>
            {notes.length} sent · {acked} acknowledged
          </span>
        </div>
        {notes.length === 0 && (
          <div className="faint" style={{ fontSize: 12 }}>No notifications sent for this job.</div>
        )}
        <div style={{ display: "grid", gap: 8 }}>
          {notes.map((n) => (
            <div
              key={n.notification_id}
              style={{
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "10px 12px",
                background: n.acknowledged ? "var(--success-bg)" : "var(--surface-2)",
              }}
            >
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <span
                  className="chip"
                  style={{ fontSize: 9 }}
                >
                  {n.channel === "technician_app" ? "→ technician" : "→ customer"}
                </span>
                <span className="mono faint" style={{ fontSize: 10 }}>{n.kind}</span>
                <span
                  style={{
                    marginLeft: "auto",
                    fontSize: 10.5,
                    fontWeight: 600,
                    color: n.acknowledged ? "var(--success)" : "var(--text-faint)",
                  }}
                >
                  {n.acknowledged
                    ? `✓ Seen ${n.acknowledged_at ? "· " + fmtSGDateTime(n.acknowledged_at) : ""}`
                    : "• awaiting acknowledgement"}
                </span>
              </div>
              <div style={{ fontSize: 12, fontWeight: 600, marginTop: 5 }}>{n.subject}</div>
              <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 3, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
                {n.body}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
