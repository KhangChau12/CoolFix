"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiGet } from "@/lib/client";
import { useRealtime } from "@/components/useRealtime";
import { TierBadge } from "@/components/ui";
import { TIER_META, type Job, type RuntimeConfig, type Technician } from "@/lib/types";
import { fmtSGTime, sgHour } from "@/lib/time";

const DAY_START = 7;
const DAY_END = 20;
const HOURS = Array.from({ length: DAY_END - DAY_START }, (_, i) => DAY_START + i);
const AVATAR_COLORS = ["#2563eb", "#e07a1f", "#7c3aed", "#16a34a", "#d0342c", "#0891b2"];

/** Singapore-local hour-of-day as a decimal (e.g. 14.5 = 14:30), for smooth positioning. */
function sgHourDecimal(iso: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h + m / 60;
}

function initials(name: string) {
  return name
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

const JOB_BLOCK_HOURS = 1.5; // visual width of a job card, in hours (~90min service window)

/**
 * Assigns each job a vertical "lane" (0, 1, 2…) so that jobs whose ~90min
 * windows overlap in time never render on top of each other. Jobs that don't
 * overlap anything reuse lane 0 (the common case — most technicians only
 * have one job in view at a time). Sorted by start time so lanes fill left-to-right.
 */
function assignLanes(dayJobs: Job[]): Map<string, number> {
  const sorted = [...dayJobs].sort(
    (a, b) => sgHourDecimal(a.scheduled_time) - sgHourDecimal(b.scheduled_time),
  );
  const laneEnds: number[] = []; // end time (decimal hour) currently occupied by each lane
  const lanes = new Map<string, number>();
  for (const j of sorted) {
    const start = sgHourDecimal(j.scheduled_time);
    const end = start + JOB_BLOCK_HOURS;
    let lane = laneEnds.findIndex((e) => e <= start);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = end;
    lanes.set(j.job_id, lane);
  }
  return lanes;
}

export default function SchedulePage() {
  const router = useRouter();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [techs, setTechs] = useState<Technician[]>([]);
  const [dayOffset, setDayOffset] = useState(0);
  const [hoverJob, setHoverJob] = useState<Job | null>(null);
  const [pinnedJob, setPinnedJob] = useState<Job | null>(null);
  const [freezeHours, setFreezeHours] = useState(2);

  const load = useCallback(async () => {
    const [j, t] = await Promise.all([
      apiGet<{ jobs: Job[] }>("/api/bookings"),
      apiGet<{ technicians: Technician[] }>("/api/technicians"),
    ]);
    setJobs(j.jobs);
    setTechs(t.technicians);
  }, []);

  useRealtime("jobs", load);
  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    apiGet<{ config: RuntimeConfig }>("/api/config")
      .then(({ config }) => setFreezeHours(config.freezeWindowHours))
      .catch(() => {
        /* ignore */
      });
  }, []);

  const nowDecimal = sgHourDecimal(new Date().toISOString());
  const isToday = dayOffset === 0;
  const shown = pinnedJob ?? hoverJob;

  const dayLabel = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + dayOffset);
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Singapore",
      weekday: "long",
      day: "2-digit",
      month: "short",
    }).format(d);
  }, [dayOffset]);

  function jobsForTechOnDay(techId: string) {
    const target = new Date();
    target.setDate(target.getDate() + dayOffset);
    const key = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore" }).format(target);
    return jobs.filter((j) => {
      if (j.assigned_technician_id !== techId) return false;
      const jKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore" }).format(
        new Date(j.scheduled_time),
      );
      return jKey === key;
    });
  }

  // "Free right now" only makes sense for today, at the current moment —
  // a technician with no job whose slot (±90min) covers `nowDecimal`.
  const freeNowCount = useMemo(() => {
    if (!isToday) return null;
    let free = 0;
    for (const t of techs) {
      const busy = jobsForTechOnDay(t.technician_id).some((j) => {
        const start = sgHourDecimal(j.scheduled_time);
        return Math.abs(start - nowDecimal) < 1.5;
      });
      if (!busy) free++;
    }
    return free;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [techs, jobs, isToday, nowDecimal]);

  return (
    <div className="stack" style={{ gap: 16 }} onClick={() => setPinnedJob(null)}>
      <div className="spread" style={{ alignItems: "flex-start" }}>
        <div>
          <h1 style={{ fontSize: 22, margin: 0 }}>Master schedule</h1>
          <p className="muted" style={{ margin: "2px 0 0", fontSize: 13 }}>
            Rows = technicians · columns = hour of day (SGT). Click a job for its full agent trail.
          </p>
          {isToday && freeNowCount !== null && (
            <div
              className="row"
              style={{
                gap: 6,
                marginTop: 8,
                fontFamily: "var(--mono)",
                fontSize: 11.5,
                color: freeNowCount === 0 ? "var(--tier-urgent)" : "var(--success)",
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 999,
                  background: freeNowCount === 0 ? "var(--tier-urgent)" : "var(--success)",
                }}
              />
              {freeNowCount} / {techs.length} technicians free right now
            </div>
          )}
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn" onClick={(e) => { e.stopPropagation(); setDayOffset((d) => d - 1); }}>←</button>
          <span className="btn" style={{ pointerEvents: "none", minWidth: 190, justifyContent: "center" }}>
            {dayLabel}
          </span>
          <button className="btn" onClick={(e) => { e.stopPropagation(); setDayOffset((d) => d + 1); }}>→</button>
          {dayOffset !== 0 && (
            <button className="btn btn-ghost" onClick={(e) => { e.stopPropagation(); setDayOffset(0); }}>today</button>
          )}
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflowX: "auto", borderRadius: 12 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ minWidth: 960 }}>
          {/* header row */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `168px repeat(${HOURS.length}, 1fr)`,
              borderBottom: "1px solid var(--border)",
              position: "sticky",
              top: 0,
              background: "var(--surface-2)",
              zIndex: 4,
            }}
          >
            <div style={{ padding: "9px 14px", fontSize: 11.5, color: "var(--text-muted)" }}>
              Technician
            </div>
            {HOURS.map((h) => {
              const isNowCol = isToday && Math.floor(nowDecimal) === h;
              return (
                <div
                  key={h}
                  style={{
                    padding: "9px 0 9px 5px",
                    fontFamily: "var(--mono)",
                    fontSize: 10.5,
                    color: isNowCol ? "var(--brand-ink)" : "var(--text-faint)",
                    fontWeight: isNowCol ? 700 : 400,
                    borderLeft: "1px solid var(--border)",
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                  }}
                >
                  {String(h).padStart(2, "0")}:00
                  {isNowCol && (
                    <span
                      style={{
                        fontSize: 8,
                        fontWeight: 700,
                        letterSpacing: "0.04em",
                        color: "#fff",
                        background: "var(--brand)",
                        borderRadius: 4,
                        padding: "1.5px 4px",
                      }}
                    >
                      NOW
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {techs.map((t, ti) => {
            const dayJobs = jobsForTechOnDay(t.technician_id);
            const avatarColor = AVATAR_COLORS[ti % AVATAR_COLORS.length];
            const isFree = dayJobs.length === 0;
            const lanes = assignLanes(dayJobs);
            const laneCount = Math.max(1, ...Array.from(lanes.values()).map((l) => l + 1));
            const LANE_H = 46;
            const rowMinHeight = Math.max(58, laneCount * LANE_H + 12);
            return (
              <div
                key={t.technician_id}
                style={{
                  display: "grid",
                  gridTemplateColumns: `168px repeat(${HOURS.length}, 1fr)`,
                  borderBottom: "1px solid var(--border)",
                  minHeight: rowMinHeight,
                  position: "relative",
                  background: isFree ? "var(--surface)" : "var(--surface)",
                  opacity: isFree ? 0.62 : 1,
                  transition: "opacity 0.15s",
                }}
              >
                <div style={{ padding: "8px 12px", display: "flex", alignItems: "center", gap: 9 }}>
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 8,
                      background: avatarColor,
                      color: "#fff",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 10.5,
                      fontWeight: 600,
                      fontFamily: "var(--mono)",
                      flexShrink: 0,
                    }}
                  >
                    {initials(t.name)}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {t.name}
                    </div>
                    <div className="faint" style={{ fontSize: 10 }}>
                      {isFree ? "free all day" : `${dayJobs.length} job${dayJobs.length === 1 ? "" : "s"} · load ${t.current_workload}`}
                    </div>
                  </div>
                </div>
                {HOURS.map((h) => {
                  const isNowCol = isToday && Math.floor(nowDecimal) === h;
                  return (
                    <div
                      key={h}
                      style={{
                        borderLeft: "1px solid var(--border)",
                        background: isNowCol ? "rgba(37,99,235,0.035)" : undefined,
                      }}
                    />
                  );
                })}

                {/* overlay spans only the hour-grid area (excludes the 168px label column);
                    left/width below are plain percentages of this overlay's own width. */}
                <div style={{ position: "absolute", top: 0, bottom: 0, left: 168, right: 0 }}>
                  {/* freeze band: now -> now + freezeHours */}
                  {isToday && nowDecimal < DAY_END && (
                    <div
                      style={{
                        position: "absolute",
                        top: 0,
                        bottom: 0,
                        left: `${((nowDecimal - DAY_START) / HOURS.length) * 100}%`,
                        width: `${(freezeHours / HOURS.length) * 100}%`,
                        background:
                          "repeating-linear-gradient(45deg, rgba(208,52,44,.09) 0 5px, rgba(208,52,44,.02) 5px 10px)",
                        borderRight: "1px dashed rgba(208,52,44,0.35)",
                        pointerEvents: "none",
                        zIndex: 1,
                      }}
                    />
                  )}

                  {/* "now" line — the NOW badge lives in the header row instead
                      (this line would clip it, being inside each row's
                      overflow-hidden band) */}
                  {isToday && nowDecimal >= DAY_START && nowDecimal < DAY_END && (
                    <div
                      style={{
                        position: "absolute",
                        top: 0,
                        bottom: 0,
                        left: `${((nowDecimal - DAY_START) / HOURS.length) * 100}%`,
                        width: 2,
                        background: "var(--brand)",
                        zIndex: 2,
                        pointerEvents: "none",
                      }}
                    />
                  )}

                  {/* job blocks */}
                  {dayJobs.map((j) => {
                    const start = sgHour(j.scheduled_time);
                    const col = start - DAY_START;
                    if (col < 0 || col >= HOURS.length) return null;
                    const leftPct = (col / HOURS.length) * 100;
                    const widthPct = (1.5 / HOURS.length) * 100; // ~90 min blocks
                    const frozen = j.status === "frozen";
                    const disrupted = j.status === "disrupted";
                    const isPinned = pinnedJob?.job_id === j.job_id;
                    const lane = lanes.get(j.job_id) ?? 0;
                    return (
                      <div
                        key={j.job_id}
                        role="button"
                        tabIndex={0}
                        onMouseEnter={() => setHoverJob(j)}
                        onMouseLeave={() => setHoverJob(null)}
                        onClick={(e) => {
                          e.stopPropagation();
                          setPinnedJob((p) => (p?.job_id === j.job_id ? null : j));
                        }}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          router.push(`/admin/jobs/${j.job_id}`);
                        }}
                        style={{
                          position: "absolute",
                          left: `${leftPct}%`,
                          width: `${widthPct}%`,
                          top: lane * LANE_H + 5,
                          height: LANE_H - 8,
                          background: `var(${TIER_META[j.tier].colorVar})`,
                          color: "#fff",
                          borderRadius: 7,
                          fontSize: 10,
                          padding: "4px 7px",
                          overflow: "hidden",
                          cursor: "pointer",
                          border: frozen
                            ? "2px solid #fff"
                            : disrupted
                              ? "2px dashed rgba(255,255,255,0.85)"
                              : isPinned
                                ? "2px solid var(--ink)"
                                : "1px solid rgba(0,0,0,0.08)",
                          outline: frozen ? "1.5px solid var(--frozen-border)" : undefined,
                          outlineOffset: frozen ? "-3.5px" : undefined,
                          backgroundImage: frozen
                            ? "repeating-linear-gradient(45deg, rgba(0,0,0,0.14) 0 4px, transparent 4px 8px)"
                            : undefined,
                          boxShadow: isPinned ? "0 0 0 3px rgba(23,22,19,0.15), var(--shadow)" : "var(--shadow-sm)",
                          zIndex: isPinned ? 5 : 3,
                          transition: "transform 0.1s, box-shadow 0.1s",
                        }}
                        title={`${j.customer_name} — click for details, double-click to open the full pipeline`}
                      >
                        <div className="row" style={{ gap: 4, alignItems: "baseline" }}>
                          <strong style={{ display: "block", whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden", flex: 1, minWidth: 0 }}>
                            {j.customer_name}
                          </strong>
                          <span className="mono" style={{ fontSize: 8.5, opacity: 0.9, flexShrink: 0 }}>
                            {fmtSGTime(j.scheduled_time)}
                          </span>
                        </div>
                        <span style={{ opacity: 0.92 }}>
                          {frozen ? "🔒 locked" : disrupted ? "⚡ disrupted" : j.status}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {shown && (
        <div
          className="card"
          onClick={(e) => e.stopPropagation()}
          style={{
            padding: 14,
            position: "fixed",
            right: 28,
            bottom: 28,
            width: 310,
            zIndex: 50,
            boxShadow: "var(--shadow-lg)",
            border: pinnedJob ? "1px solid var(--ink)" : "1px solid var(--border)",
          }}
        >
          <div className="spread">
            <strong style={{ fontSize: 13 }}>{shown.customer_name}</strong>
            <TierBadge tier={shown.tier} />
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{shown.location.address}</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            {fmtSGTime(shown.scheduled_time)} SGT · {shown.skill_required.join(", ")}
          </div>
          {shown.score_breakdown && (
            <div className="mono faint" style={{ fontSize: 11, marginTop: 8 }}>
              score {shown.score_breakdown.total} · dist {shown.score_breakdown.distance} · skill{" "}
              {shown.score_breakdown.skill_match} · urg {shown.score_breakdown.urgency} · load{" "}
              {shown.score_breakdown.workload}
            </div>
          )}
          {shown.reschedule_history.length > 0 && (
            <div className="faint" style={{ fontSize: 10, marginTop: 6 }}>
              rescheduled {shown.reschedule_history.length}× · last by{" "}
              {shown.reschedule_history.at(-1)?.decided_by}
            </div>
          )}
          <button
            className="btn btn-ghost"
            style={{ marginTop: 10, width: "100%", justifyContent: "center", fontSize: 12 }}
            onClick={(e) => {
              e.stopPropagation();
              router.push(`/admin/jobs/${shown.job_id}`);
            }}
          >
            View full pipeline →
          </button>
        </div>
      )}

      <div className="spread" style={{ flexWrap: "wrap", gap: 12 }}>
        <div className="row" style={{ gap: 16, fontSize: 11, flexWrap: "wrap" }}>
          {(["urgent", "priority", "standard", "flexible"] as const).map((t) => (
            <span key={t} className="row" style={{ gap: 5 }}>
              <span style={{ width: 12, height: 12, borderRadius: 3, background: `var(${TIER_META[t].colorVar})` }} />
              {TIER_META[t].label}
            </span>
          ))}
          <span className="row" style={{ gap: 5 }}>
            <span
              style={{
                width: 12,
                height: 12,
                borderRadius: 3,
                border: "2px solid var(--frozen-border)",
                backgroundImage: "repeating-linear-gradient(45deg,#94a3b8 0 3px,transparent 3px 6px)",
              }}
            />
            Frozen
          </span>
        </div>
        <div className="faint mono" style={{ fontSize: 11.5 }}>
          red hatched band = now → now + {freezeHours}h — jobs here cannot be re-planned automatically
        </div>
      </div>
    </div>
  );
}
