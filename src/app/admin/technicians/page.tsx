"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { apiGet, apiSend } from "@/lib/client";
import { useRealtime } from "@/components/useRealtime";
import { Toast, Avatar, Sparkline, MiniBarChart } from "@/components/ui";
import { STATUS_ICON } from "@/lib/icons";
import { SG_LANDMARKS } from "@/lib/geo";
import { sgDayKey, nowISO, fmtSGTime } from "@/lib/time";
import {
  estimatedJobMinutes,
  SKILL_LABEL,
  SKILL_CERT,
  SKILL_TAGS,
  FEEDBACK_POSITIVE_TAG_LABEL,
  FEEDBACK_IMPROVEMENT_TAG_LABEL,
  FEEDBACK_POSITIVE_TAGS,
  FEEDBACK_IMPROVEMENT_TAGS,
  type Job,
  type SkillTag,
  type Technician,
} from "@/lib/types";
import { topTags, type TechnicianRatingSummary } from "@/lib/rating";

export default function TechniciansPage() {
  const [techs, setTechs] = useState<Technician[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [ratings, setRatings] = useState<Record<string, TechnicianRatingSummary>>({});
  const [showForm, setShowForm] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; kind: "success" | "error" } | null>(null);

  const load = useCallback(async () => {
    const [t, j] = await Promise.all([
      apiGet<{ technicians: Technician[]; ratings: Record<string, TechnicianRatingSummary> }>(
        "/api/technicians",
      ),
      apiGet<{ jobs: Job[] }>("/api/bookings"),
    ]);
    setTechs(t.technicians);
    setRatings(t.ratings ?? {});
    setJobs(j.jobs);
  }, []);

  useRealtime("technicians", load);
  useRealtime("job_feedback", load);
  useEffect(() => {
    load();
  }, [load]);

  // Real hours committed TODAY against the technician's own shift length —
  // not a headcount of every job on their board against a guessed
  // nominal capacity. A tech's board can hold a dozen jobs spread across
  // the coming week without today itself being full; counting all of
  // them the same as "today's load" is the exact "workload as a job
  // counter" flaw the Assignment Agent's scoring was rewritten to avoid
  // (see coolfix-scoring-engine) — this page had its own, separate copy
  // of that same bug.
  const todayKey = sgDayKey(nowISO());
  function loadFor(t: Technician) {
    const active = jobs.filter(
      (j) => j.assigned_technician_id === t.technician_id && j.status !== "completed",
    );
    const today = active.filter((j) => sgDayKey(j.scheduled_time) === todayKey);
    const usedMin = today.reduce((s, j) => s + estimatedJobMinutes(j.skill_required), 0);
    const [sh, sm] = t.working_hours.start.split(":").map(Number);
    const [eh, em] = t.working_hours.end.split(":").map(Number);
    const shiftMin = Math.max(1, eh * 60 + em - (sh * 60 + sm));
    const next = today
      .slice()
      .sort((a, b) => a.scheduled_time.localeCompare(b.scheduled_time))[0];
    return {
      pct: Math.min(100, Math.round((usedMin / shiftMin) * 100)),
      todayCount: today.length,
      upcomingCount: active.length,
      next: next ?? null,
    };
  }

  // The one OBJECTIVE completion metric this codebase actually has real
  // data for. There's no recorded arrival-vs-scheduled timestamp anywhere
  // in the job model, so a genuine "on-time %" or "first-visit resolution
  // %" can't be computed without inventing numbers — completed job count
  // is real, and sits alongside the rating (a subjective signal) rather
  // than replacing it.
  function completedCountFor(t: Technician): number {
    return jobs.filter((j) => j.assigned_technician_id === t.technician_id && j.status === "completed").length;
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="spread">
        <div>
          <h1 style={{ fontSize: 22, margin: 0 }}>Technicians</h1>
          <p className="muted" style={{ margin: "2px 0 0", fontSize: 13 }}>
            Roster, certifications, and current load. Skill tags are hard constraints in assignment.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowForm((s) => !s)}>
          {showForm ? "Close" : "+ Add technician"}
        </button>
      </div>

      {showForm && (
        <AddTechForm
          onDone={(msg, ok) => {
            setToast({ msg, kind: ok ? "success" : "error" });
            if (ok) {
              setShowForm(false);
              load();
            }
          }}
        />
      )}

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div className="tech-table-scroll">
          <table className="tech-table">
            <thead>
              <tr>
                <th>Technician</th>
                <th>Skills</th>
                <th>Today&apos;s utilisation</th>
                <th>Board</th>
                <th>Performance</th>
                <th aria-label="Expand" />
              </tr>
            </thead>
            <tbody>
              {techs.map((t, i) => {
                const load = loadFor(t);
                const barColor =
                  load.pct > 80 ? "var(--tier-urgent)" : load.pct > 50 ? "var(--tier-priority)" : "var(--tier-flexible)";
                const rating = ratings[t.technician_id];
                const isOpen = openId === t.technician_id;
                return (
                  <Fragment key={t.technician_id}>
                  <tr>
                    <td>
                      <div className="row" style={{ gap: 10 }}>
                        <Avatar name={t.name} index={i} size={36} />
                        <div style={{ minWidth: 0 }}>
                          <div className="row" style={{ gap: 6 }}>
                            <strong style={{ fontSize: 13 }}>{t.name}</strong>
                            <span className="chip" style={{ fontSize: 9 }}>{t.experience_level}</span>
                          </div>
                          <div className="faint mono" style={{ fontSize: 10 }}>
                            {t.technician_id} · {t.working_hours.start}–{t.working_hours.end}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
                        {t.skill_tags.map((s) => (
                          <span key={s} className="chip skill" title={SKILL_CERT[s]}>
                            {SKILL_LABEL[s]}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td style={{ minWidth: 130 }}>
                      <div
                        className="spread"
                        style={{ fontSize: 11, marginBottom: 4 }}
                        title="Real hours committed today ÷ this technician's shift length — not a headcount of every job on their board."
                      >
                        <span className="mono">
                          {load.todayCount === 0 ? "free today" : `${load.pct}%`}
                        </span>
                      </div>
                      <Sparkline
                        value={Math.max(load.pct, load.todayCount ? 6 : 0)}
                        color={barColor}
                        width="100%"
                        height={7}
                      />
                    </td>
                    <td>
                      <div className="faint mono" style={{ fontSize: 10.5, lineHeight: 1.5 }}>
                        {load.todayCount} job{load.todayCount === 1 ? "" : "s"} today
                        {load.upcomingCount > load.todayCount && (
                          <>
                            <br />
                            {load.upcomingCount} on the board this week
                          </>
                        )}
                        {load.next && (
                          <>
                            <br />
                            next {fmtSGTime(load.next.scheduled_time)} · {load.next.location.address}
                          </>
                        )}
                      </div>
                    </td>
                    <td style={{ minWidth: 120 }}>
                      <RatingSummaryCell rating={rating} />
                    </td>
                    <td style={{ width: 32 }}>
                      <button
                        className="btn"
                        style={{ padding: "4px 8px", fontSize: 11 }}
                        onClick={() => setOpenId(isOpen ? null : t.technician_id)}
                        aria-label={isOpen ? "Collapse performance detail" : "Expand performance detail"}
                      >
                        {isOpen ? <STATUS_ICON.chevronUp size={13} /> : <STATUS_ICON.chevronDown size={13} />}
                      </button>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={6} style={{ background: "var(--surface-2)", padding: "16px 18px" }}>
                        <PerformanceDetail
                          technicianName={t.name}
                          rating={rating}
                          completedJobs={completedCountFor(t)}
                        />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <style>{`
        .tech-table-scroll { overflow-x: auto; }
        .tech-table { width: 100%; border-collapse: collapse; font-size: 12px; }
        .tech-table th {
          text-align: left; font-size: 10.5px; font-weight: 700; text-transform: uppercase;
          letter-spacing: 0.05em; color: var(--text-faint); padding: 10px 14px;
          border-bottom: 1px solid var(--border); white-space: nowrap;
        }
        .tech-table td {
          padding: 12px 14px; border-bottom: 1px solid var(--border); vertical-align: middle;
        }
        .tech-table tbody tr:last-child td { border-bottom: none; }
        .tech-table tbody tr:hover { background: var(--surface-2); }
      `}</style>

      {toast && <Toast message={toast.msg} kind={toast.kind} onClose={() => setToast(null)} />}
    </div>
  );
}

function AddTechForm({ onDone }: { onDone: (msg: string, ok: boolean) => void }) {
  const [name, setName] = useState("");
  const [level, setLevel] = useState<"junior" | "senior">("junior");
  const [skills, setSkills] = useState<SkillTag[]>([]);
  const [area, setArea] = useState<keyof typeof SG_LANDMARKS>("cityHall");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await apiSend("/api/technicians", "POST", {
        name,
        experience_level: level,
        skill_tags: skills,
        location: SG_LANDMARKS[area],
        working_hours: { start: "09:00", end: "18:00" },
      });
      onDone(`Added ${name}.`, true);
    } catch (e) {
      onDone((e as Error).message, false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ padding: 16 }}>
      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <label style={{ fontSize: 12 }}>
          Name
          <input
            className="btn"
            style={{ width: "100%", marginTop: 4, fontWeight: 400 }}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Alex Lim"
          />
        </label>
        <label style={{ fontSize: 12 }}>
          Experience
          <select
            className="btn"
            style={{ width: "100%", marginTop: 4, fontWeight: 400 }}
            value={level}
            onChange={(e) => setLevel(e.target.value as "junior" | "senior")}
          >
            <option value="junior">junior</option>
            <option value="senior">senior</option>
          </select>
        </label>
        <label style={{ fontSize: 12, gridColumn: "1 / -1" }}>
          Base area
          <select
            className="btn"
            style={{ width: "100%", marginTop: 4, fontWeight: 400 }}
            value={area}
            onChange={(e) => setArea(e.target.value as keyof typeof SG_LANDMARKS)}
          >
            {Object.keys(SG_LANDMARKS).map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div style={{ marginTop: 12 }}>
        <div className="faint" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em" }}>
          Certifications / skills
        </div>
        <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 6 }}>
          {SKILL_TAGS.map((s) => (
            <button
              key={s}
              className="chip"
              style={{
                cursor: "pointer",
                background: skills.includes(s) ? "var(--brand)" : "var(--surface-2)",
                color: skills.includes(s) ? "#fff" : "var(--text-muted)",
                borderColor: skills.includes(s) ? "var(--brand)" : "var(--border)",
              }}
              onClick={() =>
                setSkills((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]))
              }
            >
              {SKILL_LABEL[s]}
            </button>
          ))}
        </div>
      </div>

      <button
        className="btn btn-primary"
        style={{ marginTop: 14 }}
        disabled={busy || !name || skills.length === 0}
        onClick={submit}
      >
        {busy ? "Saving…" : "Save technician"}
      </button>
    </div>
  );
}

// ── Rating cell (roster table) ──────────────────────────────────────
// "Not enough ratings" instead of a misleading "0.0 ★" for a technician
// with zero (or very few) reviews — see rating.ts's `average: null` case.
function RatingSummaryCell({ rating }: { rating: TechnicianRatingSummary | undefined }) {
  if (!rating || rating.average == null) {
    return <span className="faint" style={{ fontSize: 11 }}>Not enough ratings</span>;
  }
  return (
    <div>
      <div className="row" style={{ gap: 5, alignItems: "baseline" }}>
        <STATUS_ICON.star size={12} strokeWidth={2} fill="#e0a72e" color="#e0a72e" />
        <strong style={{ fontSize: 13 }}>{rating.average.toFixed(1)}</strong>
        <span className="faint" style={{ fontSize: 10.5 }}>
          {rating.count} rating{rating.count === 1 ? "" : "s"}
        </span>
      </div>
      {rating.trend && rating.trend !== "flat" && (
        <div
          className="faint"
          style={{ fontSize: 10, marginTop: 2, color: rating.trend === "up" ? "var(--success)" : "var(--tier-priority)" }}
        >
          {rating.trend === "up" ? "↑ trending up" : "↓ trending down"}
        </div>
      )}
    </div>
  );
}

// ── Performance detail (expanded row) ───────────────────────────────
// Rating distribution + top tags, alongside the one objective completion
// metric this codebase actually has real data for (see completedCountFor's
// comment — no arrival timestamps exist to compute a genuine on-time %).
function PerformanceDetail({
  technicianName,
  rating,
  completedJobs,
}: {
  technicianName: string;
  rating: TechnicianRatingSummary | undefined;
  completedJobs: number;
}) {
  const r = rating;
  const topPositive = r ? topTags(r.positiveTagCounts, FEEDBACK_POSITIVE_TAGS, 3) : [];
  const topImprovement = r ? topTags(r.improvementTagCounts, FEEDBACK_IMPROVEMENT_TAGS, 3) : [];

  return (
    <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 20 }}>
      <div>
        <div className="faint" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>
          Rating distribution
        </div>
        {r && r.count > 0 ? (
          <MiniBarChart
            data={[5, 4, 3, 2, 1].map((n) => ({
              label: `${n}★`,
              value: r.distribution[n as 1 | 2 | 3 | 4 | 5],
              color: n >= 4 ? "var(--tier-flexible)" : n === 3 ? "var(--tier-priority)" : "var(--tier-urgent)",
            }))}
            height={6}
            gap={6}
          />
        ) : (
          <div className="faint" style={{ fontSize: 11.5 }}>No feedback yet for {technicianName}.</div>
        )}
        <div className="faint" style={{ fontSize: 10.5, marginTop: 10 }}>
          {completedJobs} completed job{completedJobs === 1 ? "" : "s"} (objective, from the job log)
        </div>
      </div>

      <div>
        <div className="faint" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>
          Customers mention
        </div>
        {topPositive.length === 0 && topImprovement.length === 0 ? (
          <div className="faint" style={{ fontSize: 11.5 }}>Nothing yet.</div>
        ) : (
          <div className="stack" style={{ gap: 4 }}>
            {topPositive.map(({ tag, count }) => (
              <div key={tag} className="row" style={{ gap: 6, fontSize: 11.5 }}>
                <STATUS_ICON.check size={11} strokeWidth={2.5} color="var(--success)" />
                {FEEDBACK_POSITIVE_TAG_LABEL[tag]}
                <span className="faint" style={{ marginLeft: "auto" }}>{count}</span>
              </div>
            ))}
            {topImprovement.map(({ tag, count }) => (
              <div key={tag} className="row" style={{ gap: 6, fontSize: 11.5, color: "var(--text-muted)" }}>
                <span style={{ width: 11, textAlign: "center" }}>•</span>
                {FEEDBACK_IMPROVEMENT_TAG_LABEL[tag]}
                <span className="faint" style={{ marginLeft: "auto" }}>{count}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
