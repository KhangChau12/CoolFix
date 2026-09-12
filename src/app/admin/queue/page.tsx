"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { apiGet } from "@/lib/client";
import { useRealtime } from "@/components/useRealtime";
import { TierBadge, Avatar } from "@/components/ui";
import { fmtSGDateTime, hoursBetween, nowISO } from "@/lib/time";
import {
  PIPELINE_STAGES,
  TIER_META,
  TIERS,
  type JobStatus,
  type PipelineStage,
  type Job,
  type Technician,
  type Tier,
} from "@/lib/types";

const STAGES = PIPELINE_STAGES;

function stageIndex(s: PipelineStage) {
  return STAGES.findIndex((x) => x.key === s);
}

const STAGE_DOT: Record<PipelineStage, string> = {
  intake: "var(--agent-intake)",
  pricing: "var(--agent-pricing)",
  capacity_check: "var(--agent-capacity)",
  scoring: "var(--agent-assignment)",
  assigned: "var(--border-strong)",
  disruption_review: "var(--agent-disruption)",
  awaiting_approval: "var(--tier-priority)",
  done: "var(--success)",
};

// ── Buckets: where a job "sits" for the coordinator ──────────────────
type Bucket = "attention" | "in_pipeline" | "scheduled" | "done";

const BUCKET_META: Record<
  Bucket,
  { title: string; hint: string; accent: string }
> = {
  attention: {
    title: "Needs attention",
    hint: "waiting on a coordinator, or the agent flagged it",
    accent: "var(--tier-urgent)",
  },
  in_pipeline: {
    title: "In the pipeline",
    hint: "agents still working through it",
    accent: "var(--brand)",
  },
  scheduled: {
    title: "Scheduled",
    hint: "assigned, waiting for the appointment",
    accent: "var(--success)",
  },
  done: { title: "Completed", hint: "visit finished", accent: "var(--border-strong)" },
};

function bucketOf(j: Job): Bucket {
  if (j.status === "completed") return "done";
  if (j.pipeline_stage === "done") return j.status === "frozen" ? "scheduled" : "done";
  // Disrupted, or the pipeline paused at the HITL gate → a coordinator must act.
  if (j.status === "disrupted" || j.pipeline_stage === "awaiting_approval") return "attention";
  if (j.status === "assigned" || j.status === "frozen" || j.status === "in_progress") {
    return "scheduled";
  }
  // pending / still moving through the agents
  return "in_pipeline";
}

const STATUS_LABEL: Record<JobStatus, string> = {
  pending: "Pending",
  assigned: "Assigned",
  frozen: "Locked",
  in_progress: "In progress",
  completed: "Completed",
  disrupted: "Disrupted",
};

function relTime(iso: string, now: string): string {
  const h = hoursBetween(now, iso);
  const abs = Math.abs(h);
  if (abs < 1) return h >= 0 ? "in <1h" : "<1h ago";
  if (abs < 24) return h >= 0 ? `in ${Math.round(h)}h` : `${Math.round(abs)}h ago`;
  const d = Math.round(abs / 24);
  return h >= 0 ? `in ${d}d` : `${d}d ago`;
}

export default function QueuePage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [techs, setTechs] = useState<Technician[]>([]);
  const [tierFilter, setTierFilter] = useState<Tier | "all">("all");
  const [hideCompleted, setHideCompleted] = useState(true);
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    try {
      const [j, t] = await Promise.all([
        apiGet<{ jobs: Job[] }>("/api/bookings"),
        apiGet<{ technicians: Technician[] }>("/api/technicians"),
      ]);
      setJobs(j.jobs);
      setTechs(t.technicians);
    } catch {
      /* keep last */
    }
  }, []);

  const conn = useRealtime("jobs", load);
  useEffect(() => {
    load();
  }, [load]);

  const techInfo = useCallback(
    (id: string | null) => {
      if (!id) return null;
      const idx = techs.findIndex((t) => t.technician_id === id);
      return { name: idx >= 0 ? techs[idx].name : id, index: Math.max(0, idx) };
    },
    [techs],
  );

  const now = nowISO();

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return jobs
      .filter((j) => (tierFilter === "all" ? true : j.tier === tierFilter))
      .filter((j) => (hideCompleted ? j.status !== "completed" : true))
      .filter((j) => {
        if (!needle) return true;
        return (
          j.customer_name.toLowerCase().includes(needle) ||
          j.job_id.toLowerCase().includes(needle) ||
          j.location.address.toLowerCase().includes(needle) ||
          (techInfo(j.assigned_technician_id)?.name.toLowerCase().includes(needle) ?? false)
        );
      });
  }, [jobs, tierFilter, hideCompleted, q, techInfo]);

  // Stage tallies across the *unfiltered* open set — the pipeline summary strip.
  const stageTally = useMemo(() => {
    const open = jobs.filter((j) => j.status !== "completed");
    return STAGES.map((s) => ({
      ...s,
      count: open.filter((j) => j.pipeline_stage === s.key).length,
    }));
  }, [jobs]);

  const grouped = useMemo(() => {
    const g: Record<Bucket, Job[]> = {
      attention: [],
      in_pipeline: [],
      scheduled: [],
      done: [],
    };
    for (const j of filtered) g[bucketOf(j)].push(j);
    // attention first by soonest; scheduled by soonest; done by most-recent.
    g.attention.sort((a, b) => a.scheduled_time.localeCompare(b.scheduled_time));
    g.in_pipeline.sort((a, b) => a.created_at.localeCompare(b.created_at));
    g.scheduled.sort((a, b) => a.scheduled_time.localeCompare(b.scheduled_time));
    g.done.sort((a, b) => b.scheduled_time.localeCompare(a.scheduled_time));
    return g;
  }, [filtered]);

  const order: Bucket[] = ["attention", "in_pipeline", "scheduled", "done"];
  const totalShown = filtered.length;
  const connLabel = conn === "live" ? "live" : conn === "polling" ? "polling" : "connecting";

  return (
    <div className="stack" style={{ gap: 16 }}>
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="spread" style={{ alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, margin: 0 }}>Job queue</h1>
          <p className="muted" style={{ margin: "2px 0 0", fontSize: 13 }}>
            Every job grouped by where it sits — flagged work first, then the pipeline, then
            the day&apos;s schedule.
          </p>
        </div>
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
      </div>

      {/* ── Pipeline summary strip ─────────────────────────────── */}
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div
          style={{ padding: "9px 14px 8px", borderBottom: "1px solid var(--border)" }}
        >
          <span
            className="faint"
            style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}
          >
            Open jobs by pipeline stage
          </span>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${STAGES.length}, minmax(0, 1fr))`,
          }}
        >
          {stageTally.map((s, i) => (
            <div
              key={s.key}
              style={{
                padding: "10px 8px 11px",
                textAlign: "center",
                borderLeft: i === 0 ? undefined : "1px solid var(--border)",
                background: s.count > 0 ? "var(--surface)" : "var(--surface-2)",
              }}
            >
              <div
                className="mono"
                style={{
                  fontSize: 19,
                  fontWeight: 700,
                  color: s.count > 0 ? "var(--text)" : "var(--text-faint)",
                }}
              >
                {s.count}
              </div>
              <div
                className="row"
                style={{ gap: 4, justifyContent: "center", marginTop: 3 }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 2,
                    background: STAGE_DOT[s.key],
                    opacity: s.count > 0 ? 1 : 0.4,
                    flex: "none",
                  }}
                />
                <span
                  style={{
                    fontSize: 10,
                    color: s.count > 0 ? "var(--text-muted)" : "var(--text-faint)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {s.label}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Filters ────────────────────────────────────────────── */}
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search customer, address, job id, technician…"
          className="btn"
          style={{
            flex: "1 1 240px",
            minWidth: 180,
            fontWeight: 400,
            cursor: "text",
            justifyContent: "flex-start",
          }}
        />
        <div
          className="row"
          style={{ gap: 0, border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}
        >
          {(["all", ...TIERS] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTierFilter(t)}
              className="btn btn-ghost"
              style={{
                borderRadius: 0,
                border: "none",
                fontSize: 11.5,
                textTransform: "capitalize",
                fontWeight: tierFilter === t ? 700 : 400,
                background: tierFilter === t ? "var(--ink)" : "transparent",
                color: tierFilter === t ? "#fff" : "var(--text-muted)",
              }}
            >
              {t}
            </button>
          ))}
        </div>
        <button
          onClick={() => setHideCompleted((v) => !v)}
          className="btn"
          style={{ fontSize: 11.5 }}
        >
          {hideCompleted ? "○ Completed hidden" : "● Showing completed"}
        </button>
        <span className="muted mono" style={{ fontSize: 11.5, alignSelf: "center" }}>
          {totalShown} job{totalShown === 1 ? "" : "s"}
        </span>
      </div>

      {/* ── Grouped list ──────────────────────────────────────── */}
      {totalShown === 0 && (
        <div
          className="card"
          style={{ padding: 28, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}
        >
          No jobs match the filter.
        </div>
      )}

      {order.map((b) => {
        const rows = grouped[b];
        if (rows.length === 0) return null;
        const meta = BUCKET_META[b];
        return (
          <section key={b} className="stack" style={{ gap: 8 }}>
            <div className="row" style={{ gap: 9, padding: "2px 2px" }}>
              <span
                style={{
                  width: 3,
                  height: 15,
                  borderRadius: 2,
                  background: meta.accent,
                  flex: "none",
                }}
              />
              <strong style={{ fontSize: 13 }}>{meta.title}</strong>
              <span
                className="mono"
                style={{
                  fontSize: 10.5,
                  color: "var(--text-muted)",
                  background: "var(--surface-2)",
                  borderRadius: 999,
                  padding: "1px 7px",
                }}
              >
                {rows.length}
              </span>
              <span className="faint" style={{ fontSize: 11 }}>
                {meta.hint}
              </span>
            </div>
            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
              {rows.map((j, i) => (
                <JobRow
                  key={j.job_id}
                  job={j}
                  now={now}
                  tech={techInfo(j.assigned_technician_id)}
                  first={i === 0}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ── Job row ─────────────────────────────────────────────────────────

function JobRow({
  job: j,
  now,
  tech,
  first,
}: {
  job: Job;
  now: string;
  tech: { name: string; index: number } | null;
  first: boolean;
}) {
  const idx = stageIndex(j.pipeline_stage);
  const halted = j.pipeline_stage === "awaiting_approval";
  const disrupted = j.status === "disrupted";
  const done = j.pipeline_stage === "done" || j.status === "completed";

  return (
    <Link
      href={`/admin/jobs/${j.job_id}`}
      className="list-row-link"
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1.6fr) minmax(0, 1fr) 132px 20px",
        alignItems: "center",
        gap: 12,
        padding: "11px 14px",
        borderTop: first ? undefined : "1px solid var(--border)",
        color: "var(--text)",
      }}
    >
      {/* col 1 — who + what */}
      <div style={{ minWidth: 0 }}>
        <div className="row" style={{ gap: 7, minWidth: 0 }}>
          <span className={`status-dot ${j.status}`} style={{ flex: "none" }} />
          <strong
            style={{
              fontSize: 13,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {j.customer_name}
          </strong>
          <TierBadge tier={j.tier} />
          {disrupted && <Flag color="var(--tier-urgent)">disrupted</Flag>}
          {halted && <Flag color="var(--tier-priority)">needs approval</Flag>}
        </div>
        <div
          className="muted"
          style={{
            fontSize: 11.5,
            marginTop: 3,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {j.location.address} · {j.skill_required.join(", ")} · {j.price} SGD
        </div>
        <div className="faint mono" style={{ fontSize: 10, marginTop: 2 }}>
          {j.job_id}
        </div>
      </div>

      {/* col 2 — pipeline progress */}
      <div style={{ minWidth: 0 }}>
        <PipelineTrack stageIdx={idx} halted={halted} done={done} />
        <div
          className="faint"
          style={{ fontSize: 10, marginTop: 4 }}
        >
          {done
            ? "pipeline complete"
            : halted
              ? "paused — awaiting coordinator"
              : `${STAGES[idx]?.label ?? "—"} · step ${idx + 1}/${STAGES.length}`}
        </div>
      </div>

      {/* col 3 — schedule + tech */}
      <div style={{ textAlign: "right", minWidth: 0 }}>
        <div className="mono" style={{ fontSize: 11 }}>
          {fmtSGDateTime(j.scheduled_time)}
        </div>
        <div className="faint" style={{ fontSize: 10, marginTop: 2 }}>
          {relTime(j.scheduled_time, now)}
        </div>
        <div
          className="row"
          style={{
            justifyContent: "flex-end",
            gap: 6,
            marginTop: 4,
          }}
        >
          {tech ? (
            <>
              <span
                style={{
                  fontSize: 10.5,
                  color: "var(--text-muted)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {tech.name}
              </span>
              <Avatar name={tech.name} index={tech.index} size={18} />
            </>
          ) : (
            <span style={{ fontSize: 10.5, color: "var(--text-faint)" }}>unassigned</span>
          )}
        </div>
      </div>

      {/* col 4 — affordance */}
      <span aria-hidden style={{ color: "var(--text-faint)", fontSize: 13, textAlign: "center" }}>
        →
      </span>
    </Link>
  );
}

function PipelineTrack({
  stageIdx,
  halted,
  done,
}: {
  stageIdx: number;
  halted: boolean;
  done: boolean;
}) {
  return (
    <div style={{ display: "flex", gap: 2 }} title={`Stage ${stageIdx + 1} of ${STAGES.length}`}>
      {STAGES.map((s, i) => {
        const filled = done || i < stageIdx;
        const current = !done && i === stageIdx;
        let bg = "var(--surface-2)";
        if (filled) bg = "var(--brand-tint)";
        if (current) bg = halted ? "var(--tier-priority)" : "var(--brand)";
        if (done) bg = "var(--success)";
        return (
          <span
            key={s.key}
            style={{
              flex: 1,
              height: 5,
              borderRadius: 2,
              background: bg,
              transition: "background 0.2s",
            }}
          />
        );
      })}
    </div>
  );
}

function Flag({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span
      style={{
        fontSize: 8.5,
        fontWeight: 700,
        letterSpacing: "0.03em",
        textTransform: "uppercase",
        color: "#fff",
        background: color,
        borderRadius: 999,
        padding: "1.5px 6px",
        flex: "none",
      }}
    >
      {children}
    </span>
  );
}
