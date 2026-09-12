"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiGet, apiSend } from "@/lib/client";
import { useRealtime } from "@/components/useRealtime";
import { TopBar } from "@/components/TopBar";
import { TierBadge, Avatar } from "@/components/ui";
import RecommendedRouting from "@/components/RecommendedRouting";
import { distanceKm } from "@/lib/geo";
import { TIER_META, type Job, type NotificationRecord, type Technician } from "@/lib/types";
import { fmtSGDateTime, fmtSGTime, hoursBetween, isFrozen, nowISO } from "@/lib/time";
import { STATUS_ICON } from "@/lib/icons";

export default function TechApp() {
  const [techs, setTechs] = useState<Technician[]>([]);
  const [techId, setTechId] = useState<string>("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [notes, setNotes] = useState<NotificationRecord[]>([]);
  const [openJob, setOpenJob] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [messagesOpen, setMessagesOpen] = useState(false);
  const [completedOpen, setCompletedOpen] = useState(false);
  const [techTab, setTechTab] = useState<"board" | "routing">("board");
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

  const techIndex = techs.findIndex((t) => t.technician_id === techId);
  const tech = techs.find((t) => t.technician_id === techId);
  const now = nowISO();

  const upcoming = useMemo(
    () =>
      jobs
        .filter((j) => j.status !== "completed")
        .sort((a, b) => a.scheduled_time.localeCompare(b.scheduled_time)),
    [jobs],
  );

  const completedToday = useMemo(() => {
    const todaySg = sgDayKey(new Date());
    return jobs
      .filter((j) => j.status === "completed" && sgDayKey(new Date(j.scheduled_time)) === todaySg)
      .sort((a, b) => b.scheduled_time.localeCompare(a.scheduled_time));
  }, [jobs]);

  // Today's jobs (assigned + already completed) for the timeline strip, in order.
  const todayTimeline = useMemo(() => {
    const todaySg = sgDayKey(new Date());
    return jobs
      .filter((j) => sgDayKey(new Date(j.scheduled_time)) === todaySg)
      .sort((a, b) => a.scheduled_time.localeCompare(b.scheduled_time));
  }, [jobs]);

  // A job is "overdue" if its scheduled_time has passed but it was never
  // marked en_route/arrived/completed — the technician still needs to close
  // it out. Kept separate from "upcoming" so it can't silently steal the
  // "Right now" hero slot from today's actual next stop.
  const overdue = useMemo(() => {
    const nowMs = new Date(now).getTime();
    return upcoming
      .filter((j) => j.status !== "in_progress" && new Date(j.scheduled_time).getTime() < nowMs)
      .sort((a, b) => a.scheduled_time.localeCompare(b.scheduled_time));
  }, [upcoming, now]);

  const overdueIds = useMemo(() => new Set(overdue.map((j) => j.job_id)), [overdue]);

  // The single job the "Right now" hero should show: in-progress first, else
  // the next job genuinely still ahead of now (today or later).
  const heroJob = useMemo(() => {
    const inProgress = upcoming.find((j) => j.status === "in_progress");
    if (inProgress) return inProgress;
    const nowMs = new Date(now).getTime();
    return (
      upcoming.find((j) => j.status !== "completed" && new Date(j.scheduled_time).getTime() >= nowMs) ?? null
    );
  }, [upcoming, now]);

  // Grouped-by-day view for everything after the hero job and overdue jobs
  // (rest of today + future days) — this is what "Upcoming" becomes.
  const groupedRest = useMemo(() => {
    const rest = upcoming.filter((j) => j.job_id !== heroJob?.job_id && !overdueIds.has(j.job_id));
    const groups = new Map<string, Job[]>();
    for (const j of rest) {
      const key = sgDayKey(new Date(j.scheduled_time));
      const list = groups.get(key) ?? [];
      list.push(j);
      groups.set(key, list);
    }
    return Array.from(groups.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, list]) => ({ key, label: dayGroupLabel(key), jobs: list }));
  }, [upcoming, heroJob, overdueIds]);

  const unackNotes = notes.filter((n) => !n.acknowledged);
  const recentAcked = notes
    .filter((n) => n.acknowledged)
    .sort((a, b) => (b.acknowledged_at ?? "").localeCompare(a.acknowledged_at ?? ""))
    .slice(0, 3);

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
      {/* This is a genuinely mobile-shaped app (route strip, hero job card) —
          frame it as a phone screen on wide viewports instead of stretching
          the content into a desktop layout. */}
      <div className="tech-frame-wrap">
      <div className="tech-frame" style={{ maxWidth: 460, margin: "0 auto" }}>
        {/* technician profile sub-bar (not a second page header — just the
            "who am I / what's my day" strip beneath the shared TopBar) */}
        <div style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)", padding: "12px 16px" }}>
          <div className="spread">
            {tech ? (
              <div className="row" style={{ gap: 10, minWidth: 0 }}>
                <Avatar name={tech.name} index={techIndex} size={38} />
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
        </div>

        <div role="tablist" aria-label="Technician views" style={{ display: "flex", gap: 4, padding: "8px 12px", background: "var(--surface-2)", borderBottom: "1px solid var(--border)" }}>
          <button
            role="tab"
            aria-selected={techTab === "board"}
            className={`tech-tab${techTab === "board" ? " is-active" : ""}`}
            onClick={() => setTechTab("board")}
          >
            My board
          </button>
          <button
            role="tab"
            aria-selected={techTab === "routing"}
            className={`tech-tab${techTab === "routing" ? " is-active" : ""}`}
            onClick={() => setTechTab("routing")}
          >
            Recommended routing
          </button>
        </div>

        {techTab === "routing" ? (
          <RecommendedRouting tech={tech} currentJob={heroJob} />
        ) : (
          <>
            {/* collapsible messages — never pushes the rest of the day out of view */}
            <MessagesPanel
              loading={loading}
              unack={unackNotes}
              recentAcked={recentAcked}
              open={messagesOpen}
              onToggle={() => setMessagesOpen((v) => !v)}
              onAck={ack}
            />

            {/* today's route — a real timeline with time markers + travel gaps */}
            <RouteStrip jobs={todayTimeline} loading={loading} nowISOStr={now} onPick={setOpenJob} />

            <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 18 }}>
          {/* overdue — scheduled time has passed but never marked done; these
              need to be closed out before anything else, so they sit above
              the hero job even though they're not "next" chronologically */}
          {!loading && overdue.length > 0 && (
            <div>
              <SectionLabel>
                <span style={{ color: "var(--tier-priority)" }}>Needs closing out</span>
              </SectionLabel>
              <div className="stack" style={{ gap: 6 }}>
                {overdue.map((j) => (
                  <div
                    key={j.job_id}
                    className="row"
                    style={{
                      gap: 10,
                      padding: "10px 12px",
                      border: "1px solid var(--tier-priority)",
                      background: "var(--tier-priority-bg)",
                      borderRadius: 10,
                    }}
                  >
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <strong style={{ fontSize: 12.5 }}>{j.customer_name}</strong>
                      <span className="muted" style={{ fontSize: 11, display: "block" }}>
                        Was scheduled {fmtSGWeekdayTime(j.scheduled_time)}
                      </span>
                    </span>
                    <button
                      className="btn btn-primary"
                      style={{ fontSize: 11, padding: "6px 10px", flexShrink: 0 }}
                      onClick={() => setStatus(j.job_id, "completed")}
                    >
                      Mark done
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* right now — the one job that matters most, always fully visible
              (no accordion) with its own mini-map + primary actions */}
          <div>
            <SectionLabel>Right now</SectionLabel>
            {loading ? (
              <Skeleton w="100%" h={240} r={16} />
            ) : !heroJob ? (
              <div className="card" style={{ padding: 24, textAlign: "center" }}>
                <div style={{ display: "flex", justifyContent: "center", marginBottom: 6, color: "var(--success)" }}>
                  <STATUS_ICON.check size={22} strokeWidth={2.25} />
                </div>
                <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
                  You&rsquo;re all caught up. No jobs on your board.
                </div>
              </div>
            ) : (
              <HeroJobCard
                job={heroJob}
                tech={tech}
                allJobs={upcoming}
                onStatus={setStatus}
              />
            )}
          </div>

          {/* rest of the board, grouped by day */}
          <div>
            <SectionLabel>Upcoming</SectionLabel>
            {loading ? (
              <div className="stack" style={{ gap: 8 }}>
                <Skeleton w="100%" h={56} r={10} />
                <Skeleton w="100%" h={56} r={10} />
                <Skeleton w="100%" h={56} r={10} />
              </div>
            ) : groupedRest.length === 0 ? (
              <div className="faint" style={{ fontSize: 12.5, padding: "4px 2px" }}>
                Nothing else on the board.
              </div>
            ) : (
              <div className="stack" style={{ gap: 14 }}>
                {groupedRest.map((g) => (
                  <div key={g.key}>
                    <div
                      className="faint"
                      style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}
                    >
                      {g.label} <span style={{ fontWeight: 400 }}>· {g.jobs.length} job{g.jobs.length === 1 ? "" : "s"}</span>
                    </div>
                    <div className="stack" style={{ gap: 6 }}>
                      {g.jobs.map((j) => (
                        <JobRow
                          key={j.job_id}
                          job={j}
                          tech={tech}
                          allJobs={upcoming}
                          open={openJob === j.job_id}
                          onToggle={() => setOpenJob(openJob === j.job_id ? null : j.job_id)}
                          onStatus={setStatus}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* completed today — collapsed summary */}
          {completedToday.length > 0 && (
            <div>
              <button
                onClick={() => setCompletedOpen((v) => !v)}
                style={{
                  width: "100%",
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: completedOpen ? 6 : 0,
                }}
              >
                <span
                  className="faint"
                  style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", display: "flex", alignItems: "center", gap: 6 }}
                >
                  <span style={{ color: "var(--success)", display: "inline-flex" }}>
                    <STATUS_ICON.check size={12} strokeWidth={3} />
                  </span>
                  Completed today · {completedToday.length}
                </span>
                <span className="faint" style={{ display: "inline-flex" }}>
                  {completedOpen ? (
                    <STATUS_ICON.chevronUp size={14} strokeWidth={2.25} />
                  ) : (
                    <STATUS_ICON.chevronDown size={14} strokeWidth={2.25} />
                  )}
                </span>
              </button>
              {completedOpen && (
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
                      <span style={{ color: "var(--success)", display: "inline-flex", flexShrink: 0 }}>
                        <STATUS_ICON.check size={13} strokeWidth={3} />
                      </span>
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
              )}
            </div>
          )}
            </div>
          </>
        )}
      </div>
      </div>

      <style>{`
        .tech-frame-wrap { padding: 0; }
        .tech-tab {
          flex: 1;
          border: 1px solid transparent;
          border-radius: 7px;
          background: transparent;
          color: var(--text-muted);
          padding: 8px 9px;
          font-size: 11.5px;
          font-weight: 600;
        }
        .tech-tab:hover { background: var(--surface); color: var(--text); }
        .tech-tab.is-active {
          color: var(--brand-ink);
          background: var(--surface);
          border-color: var(--border);
          box-shadow: var(--shadow-sm);
        }
        @media (min-width: 720px) {
          .tech-frame-wrap { padding: 32px 0 56px; display: flex; justify-content: center; }
          .tech-frame {
            border-radius: 28px;
            box-shadow: 0 0 0 1px var(--border), 0 20px 50px -20px rgba(26, 25, 23, 0.28);
            overflow: hidden;
            background: var(--bg);
          }
        }
      `}</style>
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

function sgDayKey(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore" }).format(d);
}

function dayGroupLabel(key: string): string {
  const todayKey = sgDayKey(new Date());
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowKey = sgDayKey(tomorrow);
  if (key === todayKey) return "Today";
  if (key === tomorrowKey) return "Tomorrow";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore",
    weekday: "long",
    day: "numeric",
    month: "short",
  }).format(new Date(`${key}T12:00:00`));
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

/* ── collapsible messages panel ─────────────────────────────────────── */

function MessagesPanel({
  loading,
  unack,
  recentAcked,
  open,
  onToggle,
  onAck,
}: {
  loading: boolean;
  unack: NotificationRecord[];
  recentAcked: NotificationRecord[];
  open: boolean;
  onToggle: () => void;
  onAck: (id: string) => void;
}) {
  if (loading) {
    return (
      <div style={{ padding: "10px 16px", background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
        <Skeleton w="100%" h={36} r={8} />
      </div>
    );
  }

  const hasUnack = unack.length > 0;

  return (
    <div style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
      <button
        onClick={onToggle}
        style={{
          width: "100%",
          padding: "10px 16px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
        }}
        aria-expanded={open}
      >
        <span className="row" style={{ gap: 8, minWidth: 0 }}>
          <span style={{ display: "inline-flex", color: hasUnack ? "var(--tier-priority)" : "var(--text-faint)" }}>
            <STATUS_ICON.bell size={15} strokeWidth={2.25} />
          </span>
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>Messages</span>
          {hasUnack && (
            <span
              style={{
                background: "var(--tier-priority)",
                color: "#fff",
                fontSize: 10.5,
                fontWeight: 700,
                borderRadius: 999,
                padding: "1px 7px",
                lineHeight: "16px",
              }}
            >
              {unack.length}
            </span>
          )}
        </span>
        <span className="faint" style={{ display: "inline-flex" }}>
          {open ? (
            <STATUS_ICON.chevronUp size={14} strokeWidth={2.25} />
          ) : (
            <STATUS_ICON.chevronDown size={14} strokeWidth={2.25} />
          )}
        </span>
      </button>

      {open && (
        <div style={{ padding: "0 16px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
          {unack.length === 0 ? (
            <div className="card" style={{ padding: "12px 14px", fontSize: 12, color: "var(--text-muted)" }}>
              No new messages.
            </div>
          ) : (
            unack.map((n) => (
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
                  onClick={() => onAck(n.notification_id)}
                >
                  <STATUS_ICON.check size={12} strokeWidth={2.5} />
                  Seen
                </button>
              </div>
            ))
          )}

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
                  <span style={{ color: "var(--success)", display: "inline-flex", flexShrink: 0 }}>
                    <STATUS_ICON.check size={13} strokeWidth={3} />
                  </span>
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
      )}
    </div>
  );
}

/* ── today's route strip ────────────────────────────────────────────── */

function RouteStrip({
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
        <Skeleton w="100%" h={64} r={8} />
      </div>
    );
  }
  if (jobs.length === 0) return null;

  const nowMs = new Date(nowISOStr).getTime();
  const inProgress = jobs.find((j) => j.status === "in_progress");
  const nextUp = jobs.find(
    (j) => j.status !== "completed" && new Date(j.scheduled_time).getTime() >= nowMs,
  );
  const currentId = inProgress?.job_id ?? nextUp?.job_id ?? null;
  const doneCount = jobs.filter((j) => j.status === "completed").length;

  return (
    <div style={{ padding: "12px 16px 14px", background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
      <div className="spread" style={{ marginBottom: 10 }}>
        <SectionLabel>My route today</SectionLabel>
        <span className="faint" style={{ fontSize: 10 }}>
          {doneCount}/{jobs.length} done
        </span>
      </div>
      {/* real timeline rail: time marker above, stop below, connector shows
          the travel gap between consecutive stops */}
      <div style={{ display: "flex", alignItems: "stretch", overflowX: "auto", paddingBottom: 4 }}>
        {jobs.map((j, i) => {
          const done = j.status === "completed";
          const active = j.job_id === currentId;
          const tierColor = `var(${TIER_META[j.tier].colorVar})`;
          const prev = jobs[i - 1];
          const gapKm = prev ? distanceKm(prev.location, j.location) : null;
          return (
            <div key={j.job_id} style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
              {i > 0 && (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 34,
                    flexShrink: 0,
                  }}
                >
                  <span
                    aria-hidden
                    style={{ width: "100%", height: 2, background: "var(--border-strong)" }}
                  />
                  {gapKm !== null && (
                    <span className="faint mono" style={{ fontSize: 8.5, marginTop: 2, whiteSpace: "nowrap" }}>
                      {gapKm.toFixed(1)}km
                    </span>
                  )}
                </div>
              )}
              <button
                onClick={() => onPick(j.job_id)}
                title={`${j.customer_name} · ${fmtSGTime(j.scheduled_time)}`}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  gap: 3,
                  minWidth: 88,
                  maxWidth: 130,
                  padding: "7px 10px",
                  border: active ? "2px solid var(--text)" : "1px solid var(--border)",
                  borderLeft: `4px solid ${tierColor}`,
                  borderRadius: 8,
                  background: done ? "var(--surface-2)" : "var(--surface)",
                  cursor: "pointer",
                  opacity: done ? 0.65 : 1,
                  boxShadow: active ? "var(--shadow-sm)" : "none",
                }}
              >
                <span className="mono" style={{ fontSize: 10, lineHeight: 1, color: "var(--text-muted)" }}>
                  {fmtSGTime(j.scheduled_time)}
                </span>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 3,
                    fontSize: 11,
                    lineHeight: 1.15,
                    fontWeight: 600,
                    color: "var(--text)",
                    overflow: "hidden",
                    maxWidth: "100%",
                  }}
                >
                  {done && <STATUS_ICON.check size={10} strokeWidth={3} color="var(--success)" />}
                  {active && !done && (
                    <span
                      aria-hidden
                      style={{ width: 5, height: 5, borderRadius: 999, background: tierColor, flexShrink: 0 }}
                    />
                  )}
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {j.customer_name}
                  </span>
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── right now: hero job card with status actions ────────────────────── */

function HeroJobCard({
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
  const tierColor = `var(${TIER_META[job.tier].colorVar})`;
  const travel = travelHint(job, tech, allJobs);
  const inProgress = job.status === "in_progress";
  const frozen = isFrozen(job.freeze_point, nowISO());

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden", borderTop: `3px solid ${tierColor}` }}>
      <div style={{ padding: "16px 17px 4px" }}>
        <div className="spread" style={{ marginBottom: 10 }}>
          <TierBadge tier={job.tier} />
          <span className="row" style={{ gap: 8 }}>
            {frozen && (
              <span title="Schedule locked" style={{ display: "inline-flex", color: "var(--status-frozen)" }}>
                <STATUS_ICON.lock size={13} strokeWidth={2.25} />
              </span>
            )}
            {job.reschedule_history.length > 0 && (
              <span title="Rescheduled by the dispatch agent" style={{ display: "inline-flex", color: "var(--tier-priority)" }}>
                <STATUS_ICON.reschedule size={13} strokeWidth={2.25} />
              </span>
            )}
          </span>
        </div>

        <div className="spread" style={{ alignItems: "flex-end", flexWrap: "wrap", gap: 14, marginBottom: 10 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.02em" }}>{job.customer_name}</div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>{job.location.address}</div>
            {travel && (
              <div className="faint" style={{ fontSize: 11, marginTop: 3 }}>
                {travel}
              </div>
            )}
          </div>
          {!inProgress && (
            <div style={{ textAlign: "right", flexShrink: 0 }}>
              <div className="mono" style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.03em", color: tierColor }}>
                {mins < 60 ? mins : (mins / 60).toFixed(1)}
              </div>
              <div className="faint" style={{ fontSize: 10.5 }}>{mins < 60 ? "min to start" : "h to start"}</div>
            </div>
          )}
          {inProgress && (
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                color: tierColor,
                border: `1px solid ${tierColor}`,
                borderRadius: 999,
                padding: "3px 9px",
                flexShrink: 0,
              }}
            >
              In progress
            </span>
          )}
        </div>

        <p style={{ fontSize: 12.5, margin: "0 0 10px", color: "var(--text-muted)", lineHeight: 1.5 }}>
          {job.problem_description}
        </p>
        <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
          {job.skill_required.map((s) => (
            <span key={s} className="chip skill" style={{ fontSize: 10 }}>
              {s}
            </span>
          ))}
        </div>
      </div>

      <div style={{ padding: "0 17px 17px", display: "flex", flexDirection: "column", gap: 8 }}>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" style={{ flex: 1, fontSize: 12.5, padding: 11 }} onClick={() => onStatus(job.job_id, "en_route")}>
            En route
          </button>
          <button className="btn" style={{ flex: 1, fontSize: 12.5, padding: 11 }} onClick={() => onStatus(job.job_id, "arrived")}>
            Arrived
          </button>
          <button
            className="btn btn-primary"
            style={{ flex: 1, fontSize: 12.5, padding: 11 }}
            onClick={() => onStatus(job.job_id, "completed")}
          >
            Complete
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── compact job row for the grouped "Upcoming" list ──────────────────── */

function JobRow({
  job,
  tech,
  allJobs,
  open,
  onToggle,
  onStatus,
}: {
  job: Job;
  tech: Technician | undefined;
  allJobs: Job[];
  open: boolean;
  onToggle: () => void;
  onStatus: (id: string, a: "en_route" | "arrived" | "completed") => void;
}) {
  const now = nowISO();
  const frozen = isFrozen(job.freeze_point, now);
  const travel = travelHint(job, tech, allJobs);

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <button
        onClick={onToggle}
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
            background: `var(${TIER_META[job.tier].colorVar})`,
            borderRadius: 999,
          }}
        />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span className="row" style={{ gap: 6 }}>
            <strong style={{ fontSize: 13 }}>{job.customer_name}</strong>
            {frozen && (
              <span title="Schedule locked" style={{ display: "inline-flex", color: "var(--status-frozen)" }}>
                <STATUS_ICON.lock size={11} strokeWidth={2.25} />
              </span>
            )}
            {job.reschedule_history.length > 0 && (
              <span title="Rescheduled by the dispatch agent" style={{ display: "inline-flex", color: "var(--tier-priority)" }}>
                <STATUS_ICON.reschedule size={11} strokeWidth={2.25} />
              </span>
            )}
          </span>
          <span className="muted" style={{ fontSize: 11, display: "block" }}>
            {fmtSGWeekdayTime(job.scheduled_time)} · {job.location.address}
          </span>
          {travel && (
            <span className="faint" style={{ fontSize: 10.5, display: "block", marginTop: 2 }}>
              {travel}
            </span>
          )}
        </span>
        <span className="faint" style={{ display: "inline-flex" }}>
          {open ? (
            <STATUS_ICON.chevronDown size={14} strokeWidth={2.25} />
          ) : (
            <STATUS_ICON.chevronRight size={14} strokeWidth={2.25} />
          )}
        </span>
      </button>

      {open && (
        <div style={{ padding: "0 12px 12px", fontSize: 12 }}>
          <TierBadge tier={job.tier} />
          <p style={{ margin: "8px 0", color: "var(--text-muted)" }}>{job.problem_description}</p>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {job.skill_required.map((s) => (
              <span key={s} className="chip skill" style={{ fontSize: 10 }}>
                {s}
              </span>
            ))}
          </div>
          <div className="row" style={{ gap: 6, marginTop: 8 }}>
            <button className="btn" style={{ flex: 1, fontSize: 11 }} onClick={() => onStatus(job.job_id, "en_route")}>
              En route
            </button>
            <button className="btn" style={{ flex: 1, fontSize: 11 }} onClick={() => onStatus(job.job_id, "arrived")}>
              Arrived
            </button>
            <button
              className="btn btn-primary"
              style={{ flex: 1, fontSize: 11 }}
              onClick={() => onStatus(job.job_id, "completed")}
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
