"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet } from "@/lib/client";
import { useRealtime } from "@/components/useRealtime";
import { TierBadge, StatusDot, EmptyState } from "@/components/ui";
import { fmtSGDateTime } from "@/lib/time";
import { PIPELINE_STAGES, TIERS, type PipelineStage, type Job, type Tier } from "@/lib/types";

const STAGES = PIPELINE_STAGES;

function stageIndex(s: PipelineStage) {
  return STAGES.findIndex((x) => x.key === s);
}

export default function QueuePage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [tierFilter, setTierFilter] = useState<Tier | "all">("all");
  const [statusFilter, setStatusFilter] = useState<string>("open");

  const load = useCallback(async () => {
    const { jobs } = await apiGet<{ jobs: Job[] }>("/api/bookings");
    setJobs(jobs);
  }, []);

  useRealtime("jobs", load);
  useEffect(() => {
    load();
  }, [load]);

  const filtered = jobs
    .filter((j) => (tierFilter === "all" ? true : j.tier === tierFilter))
    .filter((j) => {
      if (statusFilter === "all") return true;
      if (statusFilter === "open") return j.status !== "completed";
      return j.status === statusFilter;
    })
    .sort((a, b) => a.scheduled_time.localeCompare(b.scheduled_time));

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div>
        <h1 style={{ fontSize: 22, margin: 0 }}>Job queue</h1>
        <p className="muted" style={{ margin: "2px 0 0", fontSize: 13 }}>
          Every job and where it sits in the agent pipeline.
        </p>
      </div>

      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <select
          className="btn"
          value={tierFilter}
          onChange={(e) => setTierFilter(e.target.value as Tier | "all")}
        >
          <option value="all">All tiers</option>
          {TIERS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select className="btn" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="open">Open (not completed)</option>
          <option value="all">All statuses</option>
          <option value="pending">Pending</option>
          <option value="assigned">Assigned</option>
          <option value="frozen">Frozen</option>
          <option value="in_progress">In progress</option>
          <option value="completed">Completed</option>
        </select>
        <span className="muted" style={{ fontSize: 12, alignSelf: "center" }}>
          {filtered.length} job{filtered.length === 1 ? "" : "s"}
        </span>
      </div>

      {filtered.length === 0 && <EmptyState>No jobs match the filter.</EmptyState>}

      <div className="stack" style={{ gap: 10 }}>
        {filtered.map((j) => {
          const idx = stageIndex(j.pipeline_stage);
          return (
            <div key={j.job_id} className="card" style={{ padding: 14 }}>
              <div className="spread" style={{ alignItems: "flex-start" }}>
                <div>
                  <div className="row" style={{ gap: 8 }}>
                    <strong style={{ fontSize: 14 }}>{j.customer_name}</strong>
                    <TierBadge tier={j.tier} />
                    <StatusDot status={j.status} label />
                  </div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    {j.location.address} · {j.skill_required.join(", ")} · {j.price} SGD
                  </div>
                  <div className="faint mono" style={{ fontSize: 11, marginTop: 2 }}>
                    {j.job_id} · {fmtSGDateTime(j.scheduled_time)}
                    {j.assigned_technician_id && ` · → ${j.assigned_technician_id}`}
                  </div>
                </div>
              </div>

              {/* pipeline progress */}
              <div className="row" style={{ gap: 0, marginTop: 12, flexWrap: "wrap" }}>
                {STAGES.map((s, i) => {
                  const done = i < idx;
                  const current = i === idx;
                  return (
                    <div key={s.key} className="row" style={{ gap: 0 }}>
                      <span
                        style={{
                          fontSize: 10,
                          padding: "3px 8px",
                          borderRadius: 999,
                          background: current
                            ? "var(--brand)"
                            : done
                              ? "var(--brand-tint)"
                              : "var(--surface-2)",
                          color: current ? "#fff" : done ? "var(--brand-ink)" : "var(--text-faint)",
                          fontWeight: current ? 700 : 500,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {s.label}
                      </span>
                      {i < STAGES.length - 1 && (
                        <span style={{ width: 10, height: 1, background: "var(--border-strong)" }} />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
