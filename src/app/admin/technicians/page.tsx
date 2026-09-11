"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiSend } from "@/lib/client";
import { useRealtime } from "@/components/useRealtime";
import { Toast } from "@/components/ui";
import { SG_LANDMARKS } from "@/lib/geo";
import { sgDayKey, nowISO, fmtSGTime } from "@/lib/time";
import {
  estimatedJobMinutes,
  SKILL_LABEL,
  SKILL_CERT,
  SKILL_TAGS,
  type Job,
  type SkillTag,
  type Technician,
} from "@/lib/types";

export default function TechniciansPage() {
  const [techs, setTechs] = useState<Technician[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [toast, setToast] = useState<{ msg: string; kind: "success" | "error" } | null>(null);

  const load = useCallback(async () => {
    const [t, j] = await Promise.all([
      apiGet<{ technicians: Technician[] }>("/api/technicians"),
      apiGet<{ jobs: Job[] }>("/api/bookings"),
    ]);
    setTechs(t.technicians);
    setJobs(j.jobs);
  }, []);

  useRealtime("technicians", load);
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

      <div
        className="grid"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}
      >
        {techs.map((t) => {
          const load = loadFor(t);
          return (
            <div key={t.technician_id} className="card" style={{ padding: 16 }}>
              <div className="row" style={{ gap: 12 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={t.photo_url}
                  alt={t.name}
                  width={48}
                  height={48}
                  style={{ borderRadius: 999, objectFit: "cover", flex: "none" }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row" style={{ gap: 6 }}>
                    <strong style={{ fontSize: 14 }}>{t.name}</strong>
                    <span className="chip" style={{ fontSize: 9 }}>{t.experience_level}</span>
                  </div>
                  <div className="faint mono" style={{ fontSize: 10 }}>
                    {t.technician_id} · {t.working_hours.start}–{t.working_hours.end}
                  </div>
                </div>
              </div>

              <div className="row" style={{ gap: 4, flexWrap: "wrap", marginTop: 10 }}>
                {t.skill_tags.map((s) => (
                  <span key={s} className="chip skill" title={SKILL_CERT[s]}>
                    {SKILL_LABEL[s]}
                  </span>
                ))}
              </div>

              <div style={{ marginTop: 12 }}>
                <div className="spread" style={{ fontSize: 11 }}>
                  <span
                    className="muted"
                    title="Real hours committed today ÷ this technician's shift length — not a headcount of every job on their board."
                  >
                    Today&apos;s utilisation
                  </span>
                  <span className="mono">
                    {load.todayCount === 0 ? "free today" : `${load.pct}%`}
                  </span>
                </div>
                <span style={{ display: "block", height: 8, background: "var(--surface-2)", borderRadius: 999, marginTop: 4 }}>
                  <span
                    style={{
                      display: "block",
                      height: "100%",
                      width: `${Math.max(load.pct, load.todayCount ? 6 : 0)}%`,
                      background: load.pct > 80 ? "var(--tier-urgent)" : load.pct > 50 ? "var(--tier-priority)" : "var(--tier-flexible)",
                      borderRadius: 999,
                    }}
                  />
                </span>
                <div className="faint mono" style={{ fontSize: 10, marginTop: 5 }}>
                  {load.todayCount} job{load.todayCount === 1 ? "" : "s"} today
                  {load.upcomingCount > load.todayCount && ` · ${load.upcomingCount} on the board this week`}
                  {load.next && ` · next ${fmtSGTime(load.next.scheduled_time)} · ${load.next.location.address}`}
                </div>
              </div>
            </div>
          );
        })}
      </div>

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
