"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiSend } from "@/lib/client";
import { useRealtime } from "@/components/useRealtime";
import { TopBar } from "@/components/TopBar";
import { TierBadge } from "@/components/ui";
import { TIER_META, type Job, type NotificationRecord, type Technician } from "@/lib/types";
import { fmtSGDateTime, hoursBetween, isFrozen, nowISO } from "@/lib/time";

export default function TechApp() {
  const [techs, setTechs] = useState<Technician[]>([]);
  const [techId, setTechId] = useState<string>("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [notes, setNotes] = useState<NotificationRecord[]>([]);
  const [openJob, setOpenJob] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ technicians: Technician[] }>("/api/technicians").then(({ technicians }) => {
      setTechs(technicians);
      if (technicians[0]) setTechId(technicians[0].technician_id);
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
  }, [techId]);

  useRealtime("jobs", load);
  useRealtime("notifications", load);
  useEffect(() => {
    load();
  }, [load]);

  const tech = techs.find((t) => t.technician_id === techId);
  const now = nowISO();
  const upcoming = jobs
    .filter((j) => j.status !== "completed")
    .sort((a, b) => a.scheduled_time.localeCompare(b.scheduled_time));
  const next3h = upcoming.filter((j) => {
    const h = hoursBetween(now, j.scheduled_time);
    return h >= -1 && h <= 3;
  });
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
      <div style={{ maxWidth: 460, margin: "0 auto" }}>
      {/* header */}
      <div style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)", padding: "14px 16px" }}>
        <div className="spread">
          {tech && (
            <div className="row" style={{ gap: 10 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={tech.photo_url} alt={tech.name} width={40} height={40} style={{ borderRadius: 999 }} />
              <div>
                <strong style={{ fontSize: 14 }}>{tech.name}</strong>
                <div className="muted" style={{ fontSize: 12 }}>
                  {upcoming.length} jobs scheduled · {jobs.filter((j) => j.status === "completed").length} done
                </div>
              </div>
            </div>
          )}
          <select
            className="btn"
            style={{ fontSize: 12, padding: "5px 8px" }}
            value={techId}
            onChange={(e) => setTechId(e.target.value)}
          >
            {techs.map((t) => (
              <option key={t.technician_id} value={t.technician_id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
        {/* notifications — awaiting acknowledgement */}
        {unackNotes.length > 0 && (
          <div className="stack" style={{ gap: 8 }}>
            {unackNotes.map((n) => (
              <div
                key={n.notification_id}
                className="card"
                style={{ padding: 12, borderLeft: "3px solid var(--brand)" }}
              >
                <strong style={{ fontSize: 12 }}>{n.subject}</strong>
                <p style={{ fontSize: 12, margin: "4px 0 8px", color: "var(--text-muted)" }}>{n.body}</p>
                <button className="btn btn-primary" style={{ fontSize: 12, padding: "6px 12px" }} onClick={() => ack(n.notification_id)}>
                  ✓ Seen
                </button>
              </div>
            ))}
          </div>
        )}

        {/* acknowledged — keep a short trail so it's clear the tap registered
            (the coordinator sees the same acknowledgement on their side) */}
        {recentAcked.length > 0 && (
          <div className="stack" style={{ gap: 6 }}>
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

        {/* next 3 hours */}
        <div>
          <div className="faint" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
            Next 3 hours
          </div>
          {next3h.length === 0 ? (
            <div className="card" style={{ padding: 16, fontSize: 12, color: "var(--text-muted)" }}>
              Nothing in the next 3 hours.
            </div>
          ) : (
            next3h.map((j) => <BigJobCard key={j.job_id} job={j} onStatus={setStatus} />)
          )}
        </div>

        {/* full list */}
        <div>
          <div className="faint" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
            All upcoming
          </div>
          <div className="stack" style={{ gap: 8 }}>
            {upcoming.map((j) => {
              const frozen = isFrozen(j.freeze_point, now);
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
                      </span>
                      <span className="muted" style={{ fontSize: 11, display: "block" }}>
                        {new Intl.DateTimeFormat("en-GB", {
                          timeZone: "Asia/Singapore",
                          weekday: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                          hour12: false,
                        }).format(new Date(j.scheduled_time))}{" "}
                        · {j.location.address}
                      </span>
                    </span>
                    <span className="faint">{openJob === j.job_id ? "▾" : "▸"}</span>
                  </button>

                  {openJob === j.job_id && (
                    <div style={{ padding: "0 12px 12px", fontSize: 12 }}>
                      <TierBadge tier={j.tier} />
                      <p style={{ margin: "8px 0", color: "var(--text-muted)" }}>{j.problem_description}</p>
                      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                        {j.skill_required.map((s) => (
                          <span key={s} className="chip skill" style={{ fontSize: 10 }}>{s}</span>
                        ))}
                      </div>
                      <a
                        href={`https://maps.google.com/?q=${encodeURIComponent(j.location.address)}`}
                        target="_blank"
                        rel="noreferrer"
                        className="btn"
                        style={{ marginTop: 10, fontSize: 12, width: "100%", justifyContent: "center" }}
                      >
                        📍 Open in Maps
                      </a>
                      <div className="row" style={{ gap: 6, marginTop: 8 }}>
                        <button className="btn" style={{ flex: 1, fontSize: 11 }} onClick={() => setStatus(j.job_id, "en_route")}>
                          En route
                        </button>
                        <button className="btn" style={{ flex: 1, fontSize: 11 }} onClick={() => setStatus(j.job_id, "arrived")}>
                          Arrived
                        </button>
                        <button className="btn btn-primary" style={{ flex: 1, fontSize: 11 }} onClick={() => setStatus(j.job_id, "completed")}>
                          Done
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}

function BigJobCard({
  job,
  onStatus,
}: {
  job: Job;
  onStatus: (id: string, a: "en_route" | "arrived" | "completed") => void;
}) {
  const mins = Math.max(0, Math.round(hoursBetween(nowISO(), job.scheduled_time) * 60));
  const bg = `var(${TIER_META[job.tier].colorVar})`;
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
      </div>
      <div className="spread" style={{ alignItems: "flex-end", flexWrap: "wrap", gap: 14 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 21, fontWeight: 600, letterSpacing: "-0.02em" }}>{job.customer_name}</div>
          <div style={{ fontSize: 13.5, opacity: 0.92, marginTop: 3 }}>{job.location.address}</div>
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
