"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiGet } from "@/lib/client";
import { useRealtime } from "@/components/useRealtime";
import { TierBadge } from "@/components/ui";
import {
  TIER_META,
  type ApprovalRequest,
  type Job,
  type RuntimeConfig,
  type Technician,
} from "@/lib/types";
import { fmtSGTime, sgHour } from "@/lib/time";

const DAY_START = 7;
const DAY_END = 20;
const HOURS = Array.from({ length: DAY_END - DAY_START }, (_, i) => DAY_START + i);
const AVATAR_COLORS = ["#2563eb", "#e07a1f", "#7c3aed", "#16a34a", "#d0342c", "#0891b2"];
const WEEK_SPAN = 7; // days shown in the week strip / week matrix

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

/** SGT calendar-day key (YYYY-MM-DD) for an instant — the grouping key everywhere on this page. */
function sgDayKey(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore" }).format(d);
}

/** `today + offset` as a Date (local midnight is fine — only the SGT day-key is read off it). */
function dayFromOffset(offset: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d;
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

type View = "day" | "week";

export default function SchedulePage() {
  const router = useRouter();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [techs, setTechs] = useState<Technician[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [view, setView] = useState<View>("day");
  const [dayOffset, setDayOffset] = useState(0);
  const [hoverJob, setHoverJob] = useState<Job | null>(null);
  const [pinnedJob, setPinnedJob] = useState<Job | null>(null);
  const [freezeHours, setFreezeHours] = useState(2);

  const load = useCallback(async () => {
    const [j, t, a] = await Promise.all([
      apiGet<{ jobs: Job[] }>("/api/bookings"),
      apiGet<{ technicians: Technician[] }>("/api/technicians"),
      apiGet<{ approvals: ApprovalRequest[] }>("/api/approvals").catch(() => ({ approvals: [] })),
    ]);
    setJobs(j.jobs);
    setTechs(t.technicians);
    setApprovals(a.approvals);
  }, []);

  useRealtime("jobs", load);
  useRealtime("approval_requests", load);
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

  // Day-keys of jobs that still have a pending approval — surfaced as a red dot
  // on the week strip / matrix so a coordinator can see which day is contested.
  const pendingApprovalJobIds = useMemo(
    () => new Set(approvals.filter((a) => a.status === "pending").map((a) => a.job_id)),
    [approvals],
  );

  const dayLabel = useMemo(() => {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Singapore",
      weekday: "long",
      day: "2-digit",
      month: "short",
    }).format(dayFromOffset(dayOffset));
  }, [dayOffset]);

  // The 7-day window shown in the strip / matrix. Anchored so the selected day
  // is always visible: it starts on the Monday of the ISO week that contains it,
  // which keeps the columns stable as you step day-by-day inside a week.
  const weekStartOffset = useMemo(() => {
    const d = dayFromOffset(dayOffset);
    // getDay(): 0=Sun..6=Sat → days since Monday
    const sinceMonday = (d.getDay() + 6) % 7;
    return dayOffset - sinceMonday;
  }, [dayOffset]);

  const weekOffsets = useMemo(
    () => Array.from({ length: WEEK_SPAN }, (_, i) => weekStartOffset + i),
    [weekStartOffset],
  );

  const jobsByDay = useMemo(() => {
    const map = new Map<string, Job[]>();
    for (const j of jobs) {
      if (!j.assigned_technician_id) continue;
      const key = sgDayKey(new Date(j.scheduled_time));
      const arr = map.get(key);
      if (arr) arr.push(j);
      else map.set(key, [j]);
    }
    return map;
  }, [jobs]);

  function jobsForTechOnOffset(techId: string, offset: number) {
    const key = sgDayKey(dayFromOffset(offset));
    return (jobsByDay.get(key) ?? []).filter((j) => j.assigned_technician_id === techId);
  }

  const dayJobsFor = useCallback(
    (offset: number) => jobsByDay.get(sgDayKey(dayFromOffset(offset))) ?? [],
    [jobsByDay],
  );

  // "Free right now" only makes sense for today, at the current moment —
  // a technician with no job whose slot (±90min) covers `nowDecimal`.
  const freeNowCount = useMemo(() => {
    if (!isToday) return null;
    let free = 0;
    for (const t of techs) {
      const busy = jobsForTechOnOffset(t.technician_id, 0).some((j) => {
        const start = sgHourDecimal(j.scheduled_time);
        return Math.abs(start - nowDecimal) < 1.5;
      });
      if (!busy) free++;
    }
    return free;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [techs, jobsByDay, isToday, nowDecimal]);

  function openDay(offset: number, job?: Job) {
    setDayOffset(offset);
    setView("day");
    setPinnedJob(job ?? null);
  }

  return (
    <div className="stack" style={{ gap: 16 }} onClick={() => setPinnedJob(null)}>
      <div className="spread" style={{ alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 22, margin: 0 }}>Master schedule</h1>
          <p className="muted" style={{ margin: "2px 0 0", fontSize: 13 }}>
            {view === "day"
              ? "Rows = technicians · columns = hour of day (SGT). Click a job for its full agent trail."
              : "Rows = technicians · columns = day (SGT). Click a job to jump to that day."}
          </p>
          {view === "day" && isToday && freeNowCount !== null && (
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
        <div className="row" style={{ gap: 8 }} onClick={(e) => e.stopPropagation()}>
          {/* Day / Week toggle */}
          <div
            className="row"
            style={{
              gap: 0,
              border: "1px solid var(--border)",
              borderRadius: 8,
              overflow: "hidden",
            }}
          >
            {(["day", "week"] as const).map((v) => (
              <button
                key={v}
                className="btn btn-ghost"
                onClick={() => setView(v)}
                style={{
                  borderRadius: 0,
                  border: "none",
                  fontSize: 12,
                  fontWeight: view === v ? 700 : 400,
                  background: view === v ? "var(--ink)" : "transparent",
                  color: view === v ? "#fff" : "var(--text-muted)",
                  textTransform: "capitalize",
                }}
              >
                {v}
              </button>
            ))}
          </div>

          {view === "day" ? (
            <div className="row" style={{ gap: 6 }}>
              <button className="btn" onClick={() => setDayOffset((d) => d - 1)}>
                ←
              </button>
              <span
                className="btn"
                style={{ pointerEvents: "none", minWidth: 190, justifyContent: "center" }}
              >
                {dayLabel}
              </span>
              <button className="btn" onClick={() => setDayOffset((d) => d + 1)}>
                →
              </button>
              {dayOffset !== 0 && (
                <button className="btn btn-ghost" onClick={() => setDayOffset(0)}>
                  today
                </button>
              )}
            </div>
          ) : (
            <div className="row" style={{ gap: 6 }}>
              <button className="btn" onClick={() => setDayOffset((d) => d - WEEK_SPAN)}>
                ← week
              </button>
              <button className="btn" onClick={() => setDayOffset((d) => d + WEEK_SPAN)}>
                week →
              </button>
              {(weekStartOffset > 0 || weekStartOffset + WEEK_SPAN <= 0) && (
                <button className="btn btn-ghost" onClick={() => setDayOffset(0)}>
                  this week
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Week strip — 7 clickable day cards, always visible in day view */}
      {view === "day" && (
        <WeekStrip
          weekOffsets={weekOffsets}
          selectedOffset={dayOffset}
          dayJobsFor={dayJobsFor}
          pendingApprovalJobIds={pendingApprovalJobIds}
          onPick={(o) => setDayOffset(o)}
        />
      )}

      {view === "day" ? (
        <DayGantt
          techs={techs}
          jobsForTech={(id) => jobsForTechOnOffset(id, dayOffset)}
          isToday={isToday}
          nowDecimal={nowDecimal}
          freezeHours={freezeHours}
          pinnedJob={pinnedJob}
          setPinnedJob={setPinnedJob}
          setHoverJob={setHoverJob}
          onOpenJob={(id) => router.push(`/admin/jobs/${id}`)}
        />
      ) : (
        <WeekMatrix
          techs={techs}
          weekOffsets={weekOffsets}
          jobsForTechOnOffset={jobsForTechOnOffset}
          pendingApprovalJobIds={pendingApprovalJobIds}
          onPickJob={(offset, job) => openDay(offset, job)}
          onPickDay={(offset) => openDay(offset)}
        />
      )}

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
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            {shown.location.address}
          </div>
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
              <span
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 3,
                  background: `var(${TIER_META[t].colorVar})`,
                }}
              />
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
                backgroundImage:
                  "repeating-linear-gradient(45deg,#94a3b8 0 3px,transparent 3px 6px)",
              }}
            />
            Frozen
          </span>
          <span className="row" style={{ gap: 5 }}>
            <span
              style={{ width: 8, height: 8, borderRadius: 999, background: "var(--tier-urgent)" }}
            />
            Awaiting approval
          </span>
        </div>
        {view === "day" && (
          <div className="faint mono" style={{ fontSize: 11.5 }}>
            red hatched band = now → now + {freezeHours}h — jobs here cannot be re-planned
            automatically
          </div>
        )}
      </div>
    </div>
  );
}

// ── Week strip ────────────────────────────────────────────────────────

function WeekStrip({
  weekOffsets,
  selectedOffset,
  dayJobsFor,
  pendingApprovalJobIds,
  onPick,
}: {
  weekOffsets: number[];
  selectedOffset: number;
  dayJobsFor: (offset: number) => Job[];
  pendingApprovalJobIds: Set<string>;
  onPick: (offset: number) => void;
}) {
  return (
    <div
      className="card"
      style={{ padding: 6, display: "flex", gap: 6, overflowX: "auto" }}
      onClick={(e) => e.stopPropagation()}
    >
      {weekOffsets.map((offset) => {
        const d = dayFromOffset(offset);
        const dayJobs = dayJobsFor(offset);
        const isSelected = offset === selectedOffset;
        const isToday = offset === 0;
        const hasApproval = dayJobs.some((j) => pendingApprovalJobIds.has(j.job_id));
        const hasDisrupted = dayJobs.some((j) => j.status === "disrupted");
        const weekday = new Intl.DateTimeFormat("en-GB", {
          timeZone: "Asia/Singapore",
          weekday: "short",
        }).format(d);
        const dayNum = new Intl.DateTimeFormat("en-GB", {
          timeZone: "Asia/Singapore",
          day: "2-digit",
        }).format(d);
        return (
          <button
            key={offset}
            onClick={() => onPick(offset)}
            style={{
              flex: "1 1 0",
              minWidth: 78,
              padding: "8px 6px",
              borderRadius: 9,
              border: isSelected
                ? "1.5px solid var(--ink)"
                : isToday
                  ? "1px solid var(--brand)"
                  : "1px solid var(--border)",
              background: isSelected ? "var(--ink)" : "var(--surface)",
              color: isSelected ? "#fff" : "var(--text)",
              cursor: "pointer",
              textAlign: "center",
              transition: "background 0.12s, border-color 0.12s",
            }}
          >
            <div
              style={{
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                color: isSelected ? "rgba(255,255,255,0.72)" : "var(--text-faint)",
              }}
            >
              {weekday}
              {isToday ? " · today" : ""}
            </div>
            <div style={{ fontSize: 17, fontWeight: 700, fontFamily: "var(--mono)", marginTop: 1 }}>
              {dayNum}
            </div>
            <div
              className="row"
              style={{ gap: 4, justifyContent: "center", marginTop: 3, minHeight: 14 }}
            >
              <span
                style={{
                  fontSize: 10.5,
                  fontFamily: "var(--mono)",
                  color: isSelected
                    ? "rgba(255,255,255,0.85)"
                    : dayJobs.length === 0
                      ? "var(--text-faint)"
                      : "var(--text-muted)",
                }}
              >
                {dayJobs.length === 0 ? "—" : `${dayJobs.length} job${dayJobs.length === 1 ? "" : "s"}`}
              </span>
              {hasDisrupted && (
                <span
                  title="has a disrupted job"
                  style={{ width: 6, height: 6, borderRadius: 999, background: "var(--tier-priority)" }}
                />
              )}
              {hasApproval && (
                <span
                  title="awaiting coordinator approval"
                  style={{ width: 6, height: 6, borderRadius: 999, background: "var(--tier-urgent)" }}
                />
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ── Week matrix (technician × day) ────────────────────────────────────

function WeekMatrix({
  techs,
  weekOffsets,
  jobsForTechOnOffset,
  pendingApprovalJobIds,
  onPickJob,
  onPickDay,
}: {
  techs: Technician[];
  weekOffsets: number[];
  jobsForTechOnOffset: (techId: string, offset: number) => Job[];
  pendingApprovalJobIds: Set<string>;
  onPickJob: (offset: number, job: Job) => void;
  onPickDay: (offset: number) => void;
}) {
  const cols = `168px repeat(${weekOffsets.length}, 1fr)`;
  return (
    <div
      className="card"
      style={{ padding: 0, overflowX: "auto", borderRadius: 12 }}
      onClick={(e) => e.stopPropagation()}
    >
      <div style={{ minWidth: 900 }}>
        {/* header */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: cols,
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
          {weekOffsets.map((offset) => {
            const d = dayFromOffset(offset);
            const isToday = offset === 0;
            const label = new Intl.DateTimeFormat("en-GB", {
              timeZone: "Asia/Singapore",
              weekday: "short",
              day: "2-digit",
            }).format(d);
            return (
              <button
                key={offset}
                onClick={() => onPickDay(offset)}
                style={{
                  padding: "9px 6px",
                  fontFamily: "var(--mono)",
                  fontSize: 10.5,
                  fontWeight: isToday ? 700 : 400,
                  color: isToday ? "var(--brand-ink)" : "var(--text-faint)",
                  borderLeft: "1px solid var(--border)",
                  background: "transparent",
                  cursor: "pointer",
                  textAlign: "left",
                }}
                title="open this day"
              >
                {label}
              </button>
            );
          })}
        </div>

        {techs.map((t, ti) => {
          const avatarColor = AVATAR_COLORS[ti % AVATAR_COLORS.length];
          const weekJobs = weekOffsets.map((offset) => jobsForTechOnOffset(t.technician_id, offset));
          const totalThisWeek = weekJobs.reduce((n, arr) => n + arr.length, 0);
          const freeAllWeek = totalThisWeek === 0;
          return (
            <div
              key={t.technician_id}
              style={{
                display: "grid",
                gridTemplateColumns: cols,
                borderBottom: "1px solid var(--border)",
                minHeight: 62,
                background: "var(--surface)",
                opacity: freeAllWeek ? 0.55 : 1,
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
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {t.name}
                  </div>
                  <div className="faint" style={{ fontSize: 10 }}>
                    {freeAllWeek
                      ? "free all week"
                      : `${totalThisWeek} job${totalThisWeek === 1 ? "" : "s"} this week`}
                  </div>
                </div>
              </div>
              {weekJobs.map((cellJobs, ci) => {
                const offset = weekOffsets[ci];
                const isToday = offset === 0;
                const sorted = [...cellJobs].sort(
                  (a, b) => sgHourDecimal(a.scheduled_time) - sgHourDecimal(b.scheduled_time),
                );
                return (
                  <div
                    key={offset}
                    style={{
                      borderLeft: "1px solid var(--border)",
                      background: isToday ? "rgba(37,99,235,0.04)" : undefined,
                      padding: 5,
                      display: "flex",
                      flexDirection: "column",
                      gap: 3,
                    }}
                  >
                    {sorted.map((j) => {
                      const frozen = j.status === "frozen";
                      const disrupted = j.status === "disrupted";
                      const needsApproval = pendingApprovalJobIds.has(j.job_id);
                      return (
                        <button
                          key={j.job_id}
                          onClick={(e) => {
                            e.stopPropagation();
                            onPickJob(offset, j);
                          }}
                          title={`${j.customer_name} · ${fmtSGTime(j.scheduled_time)} SGT · ${j.tier}${
                            frozen ? " · locked" : disrupted ? " · disrupted" : ""
                          }`}
                          style={{
                            display: "block",
                            width: "100%",
                            textAlign: "left",
                            background: `var(${TIER_META[j.tier].colorVar})`,
                            color: "#fff",
                            borderRadius: 6,
                            border: frozen
                              ? "1.5px solid #fff"
                              : disrupted
                                ? "1.5px dashed rgba(255,255,255,0.85)"
                                : "1px solid rgba(0,0,0,0.08)",
                            outline: needsApproval ? "2px solid var(--tier-urgent)" : undefined,
                            outlineOffset: needsApproval ? "1px" : undefined,
                            backgroundImage: frozen
                              ? "repeating-linear-gradient(45deg, rgba(0,0,0,0.14) 0 4px, transparent 4px 8px)"
                              : undefined,
                            padding: "3px 6px",
                            fontSize: 10,
                            cursor: "pointer",
                            overflow: "hidden",
                          }}
                        >
                          <span
                            className="mono"
                            style={{ fontSize: 9, opacity: 0.92, display: "block" }}
                          >
                            {fmtSGTime(j.scheduled_time)}
                            {frozen ? " 🔒" : disrupted ? " ⚡" : ""}
                          </span>
                          <span
                            style={{
                              display: "block",
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              fontWeight: 600,
                            }}
                          >
                            {j.customer_name}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Day Gantt (unchanged hour-by-hour view, extracted into a component) ──

function DayGantt({
  techs,
  jobsForTech,
  isToday,
  nowDecimal,
  freezeHours,
  pinnedJob,
  setPinnedJob,
  setHoverJob,
  onOpenJob,
}: {
  techs: Technician[];
  jobsForTech: (techId: string) => Job[];
  isToday: boolean;
  nowDecimal: number;
  freezeHours: number;
  pinnedJob: Job | null;
  setPinnedJob: (fn: (p: Job | null) => Job | null) => void;
  setHoverJob: (j: Job | null) => void;
  onOpenJob: (jobId: string) => void;
}) {
  return (
    <div
      className="card"
      style={{ padding: 0, overflowX: "auto", borderRadius: 12 }}
      onClick={(e) => e.stopPropagation()}
    >
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
          const dayJobs = jobsForTech(t.technician_id);
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
                background: "var(--surface)",
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
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {t.name}
                  </div>
                  <div className="faint" style={{ fontSize: 10 }}>
                    {isFree
                      ? "free all day"
                      : `${dayJobs.length} job${dayJobs.length === 1 ? "" : "s"} · load ${t.current_workload}`}
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
                        onOpenJob(j.job_id);
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
                        boxShadow: isPinned
                          ? "0 0 0 3px rgba(23,22,19,0.15), var(--shadow)"
                          : "var(--shadow-sm)",
                        zIndex: isPinned ? 5 : 3,
                        transition: "transform 0.1s, box-shadow 0.1s",
                      }}
                      title={`${j.customer_name} — click for details, double-click to open the full pipeline`}
                    >
                      <div className="row" style={{ gap: 4, alignItems: "baseline" }}>
                        <strong
                          style={{
                            display: "block",
                            whiteSpace: "nowrap",
                            textOverflow: "ellipsis",
                            overflow: "hidden",
                            flex: 1,
                            minWidth: 0,
                          }}
                        >
                          {j.customer_name}
                        </strong>
                        <span
                          className="mono"
                          style={{ fontSize: 8.5, opacity: 0.9, flexShrink: 0 }}
                        >
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
  );
}
