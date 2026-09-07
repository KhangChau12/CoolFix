"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet } from "@/lib/client";
import { useRealtime } from "@/components/useRealtime";
import { TierBadge } from "@/components/ui";
import { TIER_META, type Job, type RuntimeConfig, type Technician } from "@/lib/types";
import { sgHour } from "@/lib/time";

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

export default function SchedulePage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [techs, setTechs] = useState<Technician[]>([]);
  const [dayOffset, setDayOffset] = useState(0);
  const [hover, setHover] = useState<Job | null>(null);
  const [freezeHours, setFreezeHours] = useState(3);

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

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="spread">
        <div>
          <h1 style={{ fontSize: 22, margin: 0 }}>Master schedule</h1>
          <p className="muted" style={{ margin: "2px 0 0", fontSize: 13 }}>
            Rows = technicians · columns = hour of day (SGT). Hatched = frozen (locked).
          </p>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn" onClick={() => setDayOffset((d) => d - 1)}>←</button>
          <span className="btn" style={{ pointerEvents: "none", minWidth: 190, justifyContent: "center" }}>
            {dayLabel}
          </span>
          <button className="btn" onClick={() => setDayOffset((d) => d + 1)}>→</button>
          {dayOffset !== 0 && (
            <button className="btn btn-ghost" onClick={() => setDayOffset(0)}>today</button>
          )}
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflowX: "auto", borderRadius: 12 }}>
        <div style={{ minWidth: 900 }}>
          {/* header row */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `160px repeat(${HOURS.length}, 1fr)`,
              borderBottom: "1px solid var(--border)",
              position: "sticky",
              top: 0,
              background: "var(--surface-2)",
              zIndex: 2,
            }}
          >
            <div style={{ padding: "9px 14px", fontSize: 11.5, color: "var(--text-muted)" }}>
              Technician
            </div>
            {HOURS.map((h) => (
              <div
                key={h}
                style={{
                  padding: "9px 0 9px 5px",
                  fontFamily: "var(--mono)",
                  fontSize: 10.5,
                  color: "var(--text-faint)",
                  borderLeft: "1px solid var(--border)",
                }}
              >
                {String(h).padStart(2, "0")}:00
              </div>
            ))}
          </div>

          {techs.map((t, ti) => {
            const dayJobs = jobsForTechOnDay(t.technician_id);
            const avatarColor = AVATAR_COLORS[ti % AVATAR_COLORS.length];
            return (
              <div
                key={t.technician_id}
                style={{
                  display: "grid",
                  gridTemplateColumns: `160px repeat(${HOURS.length}, 1fr)`,
                  borderBottom: "1px solid var(--border)",
                  minHeight: 52,
                  position: "relative",
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
                      {t.skill_tags.length} skills · load {t.current_workload}
                    </div>
                  </div>
                </div>
                {HOURS.map((h) => (
                  <div key={h} style={{ borderLeft: "1px solid var(--border)" }} />
                ))}

                {/* overlay spans only the hour-grid area (excludes the 160px label column);
                    left/width below are plain percentages of this overlay's own width. */}
                <div style={{ position: "absolute", top: 0, bottom: 0, left: 160, right: 0 }}>
                  {/* hatched frozen band: now -> now + freezeHours */}
                  {isToday && nowDecimal < DAY_END && (
                    <div
                      style={{
                        position: "absolute",
                        top: 0,
                        bottom: 0,
                        left: `${((nowDecimal - DAY_START) / HOURS.length) * 100}%`,
                        width: `${(freezeHours / HOURS.length) * 100}%`,
                        background:
                          "repeating-linear-gradient(45deg, rgba(120,115,108,.16) 0 4px, rgba(120,115,108,.05) 4px 8px)",
                        pointerEvents: "none",
                        zIndex: 1,
                      }}
                    />
                  )}

                  {/* "now" line */}
                  {isToday && nowDecimal >= DAY_START && nowDecimal < DAY_END && (
                    <div
                      style={{
                        position: "absolute",
                        top: 0,
                        bottom: 0,
                        left: `${((nowDecimal - DAY_START) / HOURS.length) * 100}%`,
                        width: 2,
                        background: "var(--ink)",
                        zIndex: 2,
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
                    return (
                      <div
                        key={j.job_id}
                        onMouseEnter={() => setHover(j)}
                        onMouseLeave={() => setHover(null)}
                        style={{
                          position: "absolute",
                          left: `${leftPct}%`,
                          width: `${widthPct}%`,
                          top: 6,
                          bottom: 6,
                          background: `var(${TIER_META[j.tier].colorVar})`,
                          color: "#fff",
                          borderRadius: 6,
                          fontSize: 10,
                          padding: "3px 6px",
                          overflow: "hidden",
                          cursor: "default",
                          border: frozen ? "2px solid var(--frozen-border)" : disrupted ? "2px dashed var(--disrupted-border)" : "none",
                          backgroundImage: frozen
                            ? "repeating-linear-gradient(45deg, rgba(255,255,255,0.18) 0 4px, transparent 4px 8px)"
                            : undefined,
                          boxShadow: "var(--shadow-sm)",
                          zIndex: 3,
                        }}
                      >
                        <strong style={{ display: "block", whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>
                          {j.customer_name}
                        </strong>
                        {frozen ? "🔒 locked" : j.status}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {hover && (
        <div className="card" style={{ padding: 14, position: "fixed", right: 28, bottom: 28, width: 300, zIndex: 50, boxShadow: "var(--shadow-lg)" }}>
          <div className="spread">
            <strong style={{ fontSize: 13 }}>{hover.customer_name}</strong>
            <TierBadge tier={hover.tier} />
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{hover.location.address}</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Skills: {hover.skill_required.join(", ")}
          </div>
          {hover.score_breakdown && (
            <div className="mono faint" style={{ fontSize: 11, marginTop: 8 }}>
              score {hover.score_breakdown.total} · dist {hover.score_breakdown.distance} · skill{" "}
              {hover.score_breakdown.skill_match} · urg {hover.score_breakdown.urgency} · load{" "}
              {hover.score_breakdown.workload}
            </div>
          )}
          {hover.reschedule_history.length > 0 && (
            <div className="faint" style={{ fontSize: 10, marginTop: 6 }}>
              rescheduled {hover.reschedule_history.length}× · last by{" "}
              {hover.reschedule_history.at(-1)?.decided_by}
            </div>
          )}
        </div>
      )}

      <div className="row" style={{ gap: 16, fontSize: 11, flexWrap: "wrap" }}>
        {(["urgent", "priority", "standard", "flexible"] as const).map((t) => (
          <span key={t} className="row" style={{ gap: 5 }}>
            <span style={{ width: 12, height: 12, borderRadius: 3, background: `var(${TIER_META[t].colorVar})` }} />
            {TIER_META[t].label}
          </span>
        ))}
        <span className="row" style={{ gap: 5 }}>
          <span style={{ width: 12, height: 12, borderRadius: 3, border: "2px solid var(--frozen-border)", backgroundImage: "repeating-linear-gradient(45deg,#94a3b8 0 3px,transparent 3px 6px)" }} />
          Frozen
        </span>
      </div>
      <div className="faint mono" style={{ fontSize: 11.5 }}>
        hatched band = now → now + {freezeHours}h, frozen by policy
      </div>
    </div>
  );
}
