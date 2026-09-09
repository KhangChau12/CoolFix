"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiGet, apiSend } from "@/lib/client";
import { useRealtime } from "@/components/useRealtime";
import { TopBar } from "@/components/TopBar";
import { TierBadge } from "@/components/ui";
import MapView from "@/components/MapView";
import { distanceKm } from "@/lib/geo";
import { TIER_META, type Job, type NotificationRecord, type Technician } from "@/lib/types";
import { fmtSGDateTime, fmtSGTime, hoursBetween, isFrozen, nowISO } from "@/lib/time";

export default function TechApp() {
  const [techs, setTechs] = useState<Technician[]>([]);
  const [techId, setTechId] = useState<string>("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [notes, setNotes] = useState<NotificationRecord[]>([]);
  const [openJob, setOpenJob] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Job ids whose embedded map failed to load (blocked tiles / offline) —
  // those fall back to the plain "Open in Maps" link only.
  const [mapFailed, setMapFailed] = useState<Set<string>>(new Set());

  useEffect(() => {
    apiGet<{ technicians: Technician[] }>("/api/technicians").then(({ technicians }) => {
      setTechs(technicians);
      // Deep-link support: /tech?tech=<id> preselects a technician (handy for
      // demos and for the coordinator opening "what does Marcus see" from admin);
      // /tech?job=<id> also expands that job.
      const params =
        typeof window !== "undefined"
          ? new URLSearchParams(window.location.search)
          : new URLSearchParams();
      const wanted = params.get("tech");
      const pick =
        technicians.find((t) => t.technician_id === wanted)?.technician_id ??
        technicians[0]?.technician_id;
      if (pick) setTechId(pick);
      const jobParam = params.get("job");
      if (jobParam) setOpenJob(jobParam);
    });
  }, []);

  const load = useCallback(async () => {
    if (!techId) return;
    const [j, n] = await Promise.all([
      apiGet<{ jobs: Job[] }>("/api/bookings"),
      apiGet<{ notifications: NotificationRecord[] }>(`/api/notifications?recipient=${techId}`),
    ]);
    setJobs(j.jobs.filter((x) => x.assigned_technician_id === techId));
    setNotes(n.notifications);
    setLoading(false);
  }, [techId]);

  useRealtime("jobs", load);
  useRealtime("notifications", load);
  const prevTechId = useRef<string>("");
  useEffect(() => {
    setLoading(true);
    // Collapse any open job when switching to a different technician, but not
    // on the first load (so a /tech?job=<id> deep link stays expanded).
    if (prevTechId.current && prevTechId.current !== techId) setOpenJob(null);
    prevTechId.current = techId;
    load();
  }, [load, techId]);

  const tech = techs.find((t) => t.technician_id === techId);
  const now = nowISO();

  const upcoming = useMemo(
    () =>
      jobs
        .filter((j) => j.status !== "completed")
        .sort((a, b) => a.scheduled_time.localeCompare(b.scheduled_time)),
    [jobs],
  );
  const next3h = upcoming.filter((j) => {
    const h = hoursBetween(now, j.scheduled_time);
    return h >= -1 && h <= 3;
  });

  const completedToday = useMemo(() => {
    const todaySg = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore" }).format(
      new Date(),
    );
    return jobs
      .filter(
        (j) =>
          j.status === "completed" &&
          new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore" }).format(
            new Date(j.scheduled_time),
          ) === todaySg,
      )
      .sort((a, b) => b.scheduled_time.localeCompare(a.scheduled_time));
  }, [jobs]);

  const unackNotes = notes.filter((n) => !n.acknowledged);
  const recentAcked = notes
    .filter((n) => n.acknowledged)
    .sort((a, b) => (b.acknowledged_at ?? "").localeCompare(a.acknowledged_at ?? ""))
    .slice(0, 3);

  // Today's jobs (assigned + already completed) for the timeline strip, in order.
  const todayTimeline = useMemo(() => {
    const todaySg = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore" }).format(
      new Date(),
    );
    return jobs
      .filter(
        (j) =>
          new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore" }).format(
            new Date(j.scheduled_time),
          ) === todaySg,
      )
      .sort((a, b) => a.scheduled_time.localeCompare(b.scheduled_time));
  }, [jobs]);

  async function ack(id: string) {
    await apiSend(`/api/notifications/${id}/ack`, "POST");
    load();
  }

  async function setStatus(jobId: string, action: "en_route" | "arrived" | "completed") {
    await apiSend(`/api/jobs/${jobId}`, "PATCH", { action });
    load();
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
      <TopBar active="technician" context="TECHNICIAN · SG" />
      <div style={{ maxWidth: 460, margin: "0 auto" }}>
        {/* technician profile sub-bar (not a second page header — just the
            "who am I / what's my day" strip beneath the shared TopBar) */}
        <div style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)", padding: "12px 16px" }}>
          <div className="spread">
            {tech ? (
              <div className="row" style={{ gap: 10, minWidth: 0 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={tech.photo_url}
                  alt={tech.name}
                  width={38}
                  height={38}
                  style={{ borderRadius: 999, flexShrink: 0, objectFit: "cover" }}
                />
                <div style={{ minWidth: 0 }}>
                  <strong style={{ fontSize: 14 }}>{tech.name}</strong>
                  <div className="muted" style={{ fontSize: 11.5 }}>
                    {tech.experience_level} · {tech.skill_tags.length} skills
                  </div>
                </div>
              </div>
            ) : (
              <div className="row" style={{ gap: 10 }}>
                <Skeleton w={38} h={38} r={999} />
                <div className="stack" style={{ gap: 5 }}>
                  <Skeleton w={120} h={13} />
                  <Skeleton w={80} h={11} />
                </div>
              </div>
            )}
            <select
              className="btn"
              style={{ fontSize: 12, padding: "5px 8px", flexShrink: 0 }}
              value={techId}
              onChange={(e) => {
                setTechId(e.target.value);
                if (typeof window !== "undefined") {
                  const u = new URL(window.location.href);
                  u.searchParams.set("tech", e.target.value);
                  window.history.replaceState(null, "", u);
                }
              }}
              aria-label="Switch technician"
            >
              {techs.map((t) => (
                <option key={t.technician_id} value={t.technician_id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>

          {/* today at a glance */}
          <div className="row" style={{ gap: 14, marginTop: 10, fontSize: 11.5 }}>
            <span className="muted">
              <strong style={{ color: "var(--text)", fontSize: 13 }}>{upcoming.length}</strong> upcoming
            </span>
            <span className="muted">
              <strong style={{ color: "var(--text)", fontSize: 13 }}>{completedToday.length}</strong> done today
            </span>
            {unackNotes.length > 0 && (
              <span style={{ color: "var(--tier-priority)", fontWeight: 600 }}>
                {unackNotes.length} to acknowledge
              </span>
            )}
          </div>
        </div>

        {/* today timeline strip */}
        <TimelineStrip jobs={todayTimeline} loading={loading} nowISOStr={now} onPick={setOpenJob} />

        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
          {/* notifications — awaiting acknowledgement */}
          <div className="stack" style={{ gap: 8 }}>
            <SectionLabel>Messages</SectionLabel>
            {loading ? (
              <Skeleton w="100%" h={70} r={10} />
            ) : unackNotes.length === 0 ? (
              <div className="card" style={{ padding: "12px 14px", fontSize: 12, color: "var(--text-muted)" }}>
                No new messages.
              </div>
            ) : (
              unackNotes.map((n) => (
                <div
                  key={n.notification_id}
                  className="card"
                  style={{ padding: 12, borderLeft: "3px solid var(--brand)" }}
                >
                  <strong style={{ fontSize: 12 }}>{n.subject}</strong>
                  <p style={{ fontSize: 12, margin: "4px 0 8px", color: "var(--text-muted)" }}>{n.body}</p>
                  <button
                    className="btn btn-primary"
                    style={{ fontSize: 12, padding: "6px 12px" }}
                    onClick={() => ack(n.notification_id)}
                  >
                    ✓ Seen
                  </button>
                </div>
              ))
            )}

            {/* acknowledged — keep a short trail so it's clear the tap registered
                (the coordinator sees the same acknowledgement on their side) */}
            {recentAcked.length > 0 && (
              <div className="stack" style={{ gap: 6, marginTop: 2 }}>
                <div className="faint" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  Acknowledged
                </div>
                {recentAcked.map((n) => (
                  <div
                    key={n.notification_id}
                    className="row"
                    style={{
                      gap: 8,
                      fontSize: 11.5,
                      color: "var(--text-muted)",
                      padding: "7px 10px",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      background: "var(--success-bg)",
                    }}
                  >
                    <span style={{ color: "var(--success)", fontWeight: 700 }}>✓</span>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {n.subject}
                    </span>
                    {n.acknowledged_at && (
                      <span className="mono faint" style={{ fontSize: 10 }}>
                        {fmtSGDateTime(n.acknowledged_at)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* next 3 hours */}
          <div>
            <SectionLabel>Next 3 hours</SectionLabel>
            {loading ? (
              <Skeleton w="100%" h={150} r={14} />
            ) : next3h.length === 0 ? (
              <div className="card" style={{ padding: 16, fontSize: 12, color: "var(--text-muted)" }}>
                Nothing in the next 3 hours.
              </div>
            ) : (
              next3h.map((j) => (
                <BigJobCard key={j.job_id} job={j} tech={tech} allJobs={upcoming} onStatus={setStatus} />
              ))
            )}
          </div>

          {/* full list */}
          <div>
            <SectionLabel>All upcoming</SectionLabel>
            {loading ? (
              <div className="stack" style={{ gap: 8 }}>
                <Skeleton w="100%" h={56} r={10} />
                <Skeleton w="100%" h={56} r={10} />
                <Skeleton w="100%" h={56} r={10} />
              </div>
            ) : upcoming.length === 0 ? (
              <div
                className="card"
                style={{ padding: 24, textAlign: "center", fontSize: 13, color: "var(--text-muted)" }}
              >
                <div style={{ fontSize: 22, marginBottom: 4 }}>✓</div>
                You&rsquo;re all caught up. No jobs on your board.
              </div>
            ) : (
              <div className="stack" style={{ gap: 8 }}>
                {upcoming.map((j) => {
                  const frozen = isFrozen(j.freeze_point, now);
                  const travel = travelHint(j, tech, upcoming);
                  return (
                    <div key={j.job_id} className="card" style={{ padding: 0, overflow: "hidden" }}>
                      <button
                        onClick={() => setOpenJob(openJob === j.job_id ? null : j.job_id)}
                        style={{
                          width: "100%",
                          padding: 12,
                          background: "transparent",
                          border: "none",
                          textAlign: "left",
                          display: "flex",
                          gap: 10,
                          alignItems: "center",
                        }}
                      >
                        <span
                          style={{
                            width: 4,
                            alignSelf: "stretch",
                            background: `var(${TIER_META[j.tier].colorVar})`,
                            borderRadius: 999,
                          }}
                        />
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span className="row" style={{ gap: 6 }}>
                            <strong style={{ fontSize: 13 }}>{j.customer_name}</strong>
                            {frozen && <span title="Schedule locked">🔒</span>}
                            {j.reschedule_history.length > 0 && (
                              <span title="Rescheduled by the dispatch agent" style={{ fontSize: 11 }}>
                                🔁
                              </span>
                            )}
                          </span>
                          <span className="muted" style={{ fontSize: 11, display: "block" }}>
                            {fmtSGWeekdayTime(j.scheduled_time)} · {j.location.address}
                          </span>
                          {travel && (
                            <span className="faint" style={{ fontSize: 10.5, display: "block", marginTop: 2 }}>
                              {travel}
                            </span>
                          )}
                        </span>
                        <span className="faint">{openJob === j.job_id ? "▾" : "▸"}</span>
                      </button>

                      {openJob === j.job_id && (
                        <div style={{ padding: "0 12px 12px", fontSize: 12 }}>
                          <TierBadge tier={j.tier} />
                          <p style={{ margin: "8px 0", color: "var(--text-muted)" }}>{j.problem_description}</p>
                          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                            {j.skill_required.map((s) => (
                              <span key={s} className="chip skill" style={{ fontSize: 10 }}>
                                {s}
                              </span>
                            ))}
                          </div>
                          {!mapFailed.has(j.job_id) && (
                            <div style={{ marginTop: 10 }}>
                              <MapView
                                mode="display"
                                customer={{ lat: j.location.lat, lng: j.location.lng, address: j.location.address }}
                                technician={
                                  tech
                                    ? { lat: tech.location.lat, lng: tech.location.lng, name: tech.name }
                                    : null
                                }
                                active={j.status === "in_progress"}
                                height={180}
                                onUnavailable={() =>
                                  setMapFailed((s) => new Set(s).add(j.job_id))
                                }
                              />
                            </div>
                          )}
                          <a
                            href={`https://maps.google.com/?q=${encodeURIComponent(j.location.address)}`}
                            target="_blank"
                            rel="noreferrer"
                            className="btn"
                            style={{ marginTop: 10, fontSize: 12, width: "100%", justifyContent: "center" }}
                          >
                            📍 Directions in Google Maps
                          </a>
                          <div className="row" style={{ gap: 6, marginTop: 8 }}>
                            <button className="btn" style={{ flex: 1, fontSize: 11 }} onClick={() => setStatus(j.job_id, "en_route")}>
                              En route
                            </button>
                            <button className="btn" style={{ flex: 1, fontSize: 11 }} onClick={() => setStatus(j.job_id, "arrived")}>
                              Arrived
                            </button>
                            <button
                              className="btn btn-primary"
                              style={{ flex: 1, fontSize: 11 }}
                              onClick={() => setStatus(j.job_id, "completed")}
                            >
                              Done
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* completed today */}
          {completedToday.length > 0 && (
            <div>
              <SectionLabel>Completed today</SectionLabel>
              <div className="stack" style={{ gap: 6 }}>
                {completedToday.map((j) => (
                  <div
                    key={j.job_id}
                    className="row"
                    style={{
                      gap: 8,
                      fontSize: 12,
                      padding: "9px 11px",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      background: "var(--surface)",
                    }}
                  >
                    <span style={{ color: "var(--success)", fontWeight: 700 }}>✓</span>
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {j.customer_name}
                    </span>
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 999,
                        background: `var(${TIER_META[j.tier].colorVar})`,
                        flexShrink: 0,
                      }}
                    />
                    <span className="mono faint" style={{ fontSize: 10.5 }}>
                      {fmtSGTime(j.scheduled_time)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── small helpers ──────────────────────────────────────────────────── */

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="faint"
      style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}
    >
      {children}
    </div>
  );
}

function Skeleton({
  w,
  h,
  r = 6,
}: {
  w: number | string;
  h: number | string;
  r?: number;
}) {
  return (
    <span
      aria-hidden
      style={{
        display: "block",
        width: typeof w === "number" ? `${w}px` : w,
        height: typeof h === "number" ? `${h}px` : h,
        borderRadius: r,
        background:
          "linear-gradient(90deg, var(--surface-2) 25%, var(--border) 37%, var(--surface-2) 63%)",
        backgroundSize: "400% 100%",
        animation: "tech-shimmer 1.4s ease infinite",
      }}
    >
      <style>{`@keyframes tech-shimmer { 0% { background-position: 100% 0 } 100% { background-position: -100% 0 } }`}</style>
    </span>
  );
}

function fmtSGWeekdayTime(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

/** "~1.5 km · after your 13:30 job" — one line of routing context for a card. */
function travelHint(job: Job, tech: Technician | undefined, dayJobs: Job[]): string | null {
  const parts: string[] = [];

  // Distance from the previous job on the same day (or from home base).
  const earlier = dayJobs
    .filter(
      (j) =>
        j.job_id !== job.job_id &&
        j.scheduled_time < job.scheduled_time &&
        sameSgDay(j.scheduled_time, job.scheduled_time),
    )
    .sort((a, b) => b.scheduled_time.localeCompare(a.scheduled_time));

  const from = earlier[0]?.location ?? tech?.location;
  if (from) {
    const km = distanceKm(from, job.location);
    parts.push(`~${km.toFixed(1)} km`);
  }

  if (earlier[0]) {
    parts.push(`after your ${fmtSGTime(earlier[0].scheduled_time)} job`);
  } else if (from === tech?.location) {
    parts.push("first stop of the day");
  }

  return parts.length ? parts.join(" · ") : null;
}

function sameSgDay(a: string, b: string): boolean {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore" });
  return f.format(new Date(a)) === f.format(new Date(b));
}

/* ── today timeline strip ───────────────────────────────────────────── */

function TimelineStrip({
  jobs,
  loading,
  nowISOStr,
  onPick,
}: {
  jobs: Job[];
  loading: boolean;
  nowISOStr: string;
  onPick: (id: string) => void;
}) {
  if (loading) {
    return (
      <div style={{ padding: "12px 16px", background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
        <Skeleton w="100%" h={44} r={8} />
      </div>
    );
  }
  if (jobs.length === 0) return null;

  // Which job is "current" — the one in progress, else the next one still ahead.
  const nowMs = new Date(nowISOStr).getTime();
  const inProgress = jobs.find((j) => j.status === "in_progress");
  const nextUp = jobs.find(
    (j) => j.status !== "completed" && new Date(j.scheduled_time).getTime() >= nowMs,
  );
  const currentId = inProgress?.job_id ?? nextUp?.job_id ?? null;
  const doneCount = jobs.filter((j) => j.status === "completed").length;

  return (
    <div style={{ padding: "12px 16px 14px", background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
      <div className="spread" style={{ marginBottom: 8 }}>
        <SectionLabel>My day</SectionLabel>
        <span className="faint" style={{ fontSize: 10 }}>
          {doneCount}/{jobs.length} done
        </span>
      </div>
      {/* horizontal sequence of stops — never clips, scrolls if the day is long */}
      <div
        style={{
          display: "flex",
          alignItems: "stretch",
          gap: 6,
          overflowX: "auto",
          paddingBottom: 2,
        }}
      >
        {jobs.map((j, i) => {
          const done = j.status === "completed";
          const active = j.job_id === currentId;
          const tierColor = `var(${TIER_META[j.tier].colorVar})`;
          return (
            <div key={j.job_id} style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
              {i > 0 && (
                <span
                  aria-hidden
                  style={{ width: 10, height: 2, background: "var(--border-strong)", flexShrink: 0 }}
                />
              )}
              <button
                onClick={() => onPick(j.job_id)}
                title={`${j.customer_name} · ${fmtSGTime(j.scheduled_time)}`}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  gap: 2,
                  minWidth: 78,
                  maxWidth: 120,
                  padding: "6px 9px",
                  border: active ? "2px solid var(--text)" : "1px solid var(--border)",
                  borderLeft: `4px solid ${tierColor}`,
                  borderRadius: 8,
                  background: done ? "var(--surface-2)" : "var(--surface)",
                  cursor: "pointer",
                  opacity: done ? 0.65 : 1,
                  boxShadow: active ? "var(--shadow-sm)" : "none",
                }}
              >
                <span
                  className="mono"
                  style={{ fontSize: 10, lineHeight: 1, color: "var(--text-muted)" }}
                >
                  {fmtSGTime(j.scheduled_time)}
                </span>
                <span
                  style={{
                    fontSize: 11,
                    lineHeight: 1.15,
                    fontWeight: 600,
                    color: "var(--text)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    maxWidth: "100%",
                  }}
                >
                  {done ? "✓ " : active ? "▸ " : ""}
                  {j.customer_name}
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BigJobCard({
  job,
  tech,
  allJobs,
  onStatus,
}: {
  job: Job;
  tech: Technician | undefined;
  allJobs: Job[];
  onStatus: (id: string, a: "en_route" | "arrived" | "completed") => void;
}) {
  const mins = Math.max(0, Math.round(hoursBetween(nowISO(), job.scheduled_time) * 60));
  const bg = `var(${TIER_META[job.tier].colorVar})`;
  const travel = travelHint(job, tech, allJobs);
  return (
    <div
      style={{
        background: bg,
        color: "#fff",
        borderRadius: 14,
        padding: "16px 17px",
        marginBottom: 8,
        boxShadow: "0 2px 10px rgba(0,0,0,.18)",
      }}
    >
      <div className="spread" style={{ marginBottom: 12 }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 11, letterSpacing: "0.06em", opacity: 0.85 }}>
          {TIER_META[job.tier].label.toUpperCase()}
        </span>
        {job.reschedule_history.length > 0 && (
          <span style={{ fontSize: 10.5, opacity: 0.9 }}>🔁 rescheduled</span>
        )}
      </div>
      <div className="spread" style={{ alignItems: "flex-end", flexWrap: "wrap", gap: 14 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 21, fontWeight: 600, letterSpacing: "-0.02em" }}>{job.customer_name}</div>
          <div style={{ fontSize: 13.5, opacity: 0.92, marginTop: 3 }}>{job.location.address}</div>
          {travel && <div style={{ fontSize: 11.5, opacity: 0.8, marginTop: 3 }}>{travel}</div>}
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 30, fontWeight: 600, letterSpacing: "-0.03em" }}>
            {mins < 60 ? mins : (mins / 60).toFixed(1)}
          </div>
          <div style={{ fontSize: 11, opacity: 0.8 }}>{mins < 60 ? "min until start" : "h until start"}</div>
        </div>
      </div>
      <p style={{ fontSize: 12.5, margin: "10px 0", opacity: 0.92, lineHeight: 1.5 }}>{job.problem_description}</p>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button
          style={{ flex: 1, minWidth: 100, fontFamily: "inherit", fontSize: 13, fontWeight: 600, background: "#fff", color: "#1a1917", border: "none", borderRadius: 8, padding: 11, cursor: "pointer" }}
          onClick={() => onStatus(job.job_id, "en_route")}
        >
          En route
        </button>
        <button
          style={{ flex: 1, minWidth: 100, fontFamily: "inherit", fontSize: 13, fontWeight: 500, background: "rgba(0,0,0,.22)", color: "#fff", border: "none", borderRadius: 8, padding: 11, cursor: "pointer" }}
          onClick={() => onStatus(job.job_id, "arrived")}
        >
          Arrived
        </button>
        <button
          style={{ flex: 1, minWidth: 100, fontFamily: "inherit", fontSize: 13, fontWeight: 500, background: "rgba(0,0,0,.22)", color: "#fff", border: "none", borderRadius: 8, padding: 11, cursor: "pointer" }}
          onClick={() => onStatus(job.job_id, "completed")}
        >
          Complete
        </button>
      </div>
    </div>
  );
}
