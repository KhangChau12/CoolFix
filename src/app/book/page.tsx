"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { apiGet, apiSend } from "@/lib/client";
import { useRealtime } from "@/components/useRealtime";
import { TopBar } from "@/components/TopBar";
import { SG_LANDMARKS } from "@/lib/geo";
import { hoursBetween, nowISO } from "@/lib/time";
import {
  PROBLEM_CATEGORIES,
  TIER_META,
  TIERS,
  TIER_SLA_TEXT,
  DEFAULT_CONFIG,
  CATEGORY_HINT_SKILL,
  type AgentDecisionLog,
  type Job,
  type Technician,
  type Tier,
} from "@/lib/types";
import type { PipelineResult } from "@/agents/orchestrator";

type Step = "welcome" | "form" | "tier" | "confirm" | "processing" | "track";

const AREA_KEYS = Object.keys(SG_LANDMARKS) as (keyof typeof SG_LANDMARKS)[];

function estPrice(categoryValue: string, tier: Tier): number {
  const skill = CATEGORY_HINT_SKILL[categoryValue] ?? "basic_maintenance";
  return Math.round(DEFAULT_CONFIG.basePrice[skill] * TIER_META[tier].priceMultiplier);
}

export default function BookPage() {
  const [step, setStep] = useState<Step>("welcome");
  const [form, setForm] = useState({
    customer_name: "",
    customer_email: "",
    customer_phone: "",
    address: "",
    area: "cityHall" as keyof typeof SG_LANDMARKS,
    problem_category: PROBLEM_CATEGORIES[0].value,
    problem_description: "",
  });
  const [tier, setTier] = useState<Tier>("standard");
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function upd<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function submit() {
    setBusy(true);
    setErr(null);
    // Move to the processing screen immediately — the pipeline runs
    // server-side for 10-15s on the real model, and the customer should see
    // it working (live pipeline steps) instead of a frozen "Submitting…"
    // button. The request keeps running; when it resolves we swap to the
    // full tracker.
    setStep("processing");
    try {
      const r = await apiSend<PipelineResult>("/api/bookings", "POST", {
        customer_name: form.customer_name,
        customer_email: form.customer_email,
        customer_phone: form.customer_phone,
        address: form.address,
        location: SG_LANDMARKS[form.area],
        problem_category: form.problem_category,
        problem_description: form.problem_description,
        photo_url: null,
        tier,
        preferred_date: null,
      });
      setResult(r);
      setStep("track");
    } catch (e) {
      setErr((e as Error).message);
      // Stay on the processing screen so the error + retry are shown in
      // context, not back on a form the customer already filled in.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-customer)" }}>
      <TopBar active="customer" context="BOOKING · SG" />
      <div style={{ maxWidth: 620, margin: "0 auto", padding: "22px 20px 72px" }}>
        <Stepper step={step} />

        {step === "welcome" && (
          <div className="card" style={{ padding: 28 }}>
            <h1 style={{ fontSize: 22 }}>Book an aircon service</h1>
            <p className="muted">
              Tell us what's wrong, pick how fast you need it, and we'll dispatch a
              certified technician. You'll get a booking code to track progress.
            </p>
            <button className="btn btn-primary btn-lg" onClick={() => setStep("form")}>
              Start
            </button>
          </div>
        )}

        {step === "form" && (
          <div className="card" style={{ padding: 24 }}>
            <h2 style={{ fontSize: 18 }}>Describe the problem</h2>
            <div className="stack" style={{ gap: 12, marginTop: 12 }}>
              <Field label="Your name">
                <input className="inp" value={form.customer_name} onChange={(e) => upd("customer_name", e.target.value)} />
              </Field>
              <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Field label="Email">
                  <input className="inp" type="email" value={form.customer_email} onChange={(e) => upd("customer_email", e.target.value)} />
                </Field>
                <Field label="Phone">
                  <input className="inp" value={form.customer_phone} onChange={(e) => upd("customer_phone", e.target.value)} />
                </Field>
              </div>
              <Field label="Address">
                <input className="inp" placeholder="Block, street, unit" value={form.address} onChange={(e) => upd("address", e.target.value)} />
              </Field>
              <Field label="Area (for routing)">
                <select className="inp" value={form.area} onChange={(e) => upd("area", e.target.value as keyof typeof SG_LANDMARKS)}>
                  {AREA_KEYS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Problem type">
                <select
                  className="inp"
                  value={form.problem_category}
                  onChange={(e) => upd("problem_category", e.target.value)}
                >
                  {PROBLEM_CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Describe what's happening (free text)">
                <textarea
                  className="inp"
                  rows={4}
                  placeholder="e.g. The living room unit stopped blowing cold air yesterday and there's ice on the pipe."
                  value={form.problem_description}
                  onChange={(e) => upd("problem_description", e.target.value)}
                />
              </Field>
            </div>
            <div className="row" style={{ gap: 8, marginTop: 16 }}>
              <button className="btn btn-ghost" onClick={() => setStep("welcome")}>Back</button>
              <button
                className="btn btn-primary"
                disabled={!form.customer_name || !form.customer_email || !form.address || !form.problem_description}
                onClick={() => setStep("tier")}
              >
                Next: choose speed
              </button>
            </div>
          </div>
        )}

        {step === "tier" && (
          <div className="card" style={{ padding: 24 }}>
            <h2 style={{ fontSize: 18 }}>How fast do you need it?</h2>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}>
              {TIERS.map((t) => {
                const m = TIER_META[t];
                const active = tier === t;
                return (
                  <button
                    key={t}
                    onClick={() => setTier(t)}
                    style={{
                      display: "flex",
                      alignItems: "stretch",
                      gap: 14,
                      width: "100%",
                      textAlign: "left",
                      background: "var(--surface)",
                      border: `1px solid ${active ? `var(${m.colorVar})` : "var(--border)"}`,
                      boxShadow: active ? `0 0 0 2px color-mix(in srgb, var(${m.colorVar}) 20%, transparent)` : "none",
                      borderRadius: 12,
                      padding: "15px 16px",
                    }}
                  >
                    <div style={{ width: 5, borderRadius: 3, background: `var(${m.colorVar})`, flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="row" style={{ gap: 9, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 16, fontWeight: 600 }}>{m.emoji} {m.label}</span>
                        <span
                          className="mono"
                          style={{
                            fontSize: 11,
                            color: `var(${m.colorVar})`,
                            background: `var(${m.colorVar}-bg)`,
                            border: `1px solid var(${m.colorVar})`,
                            borderRadius: 5,
                            padding: "2px 7px",
                          }}
                        >
                          {TIER_SLA_TEXT[t]}
                        </span>
                      </div>
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <div className="mono" style={{ fontSize: 19, fontWeight: 600 }}>
                        ~{estPrice(form.problem_category, t)} SGD
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
            <div className="row" style={{ gap: 8, marginTop: 16 }}>
              <button className="btn btn-ghost" onClick={() => setStep("form")}>Back</button>
              <button className="btn btn-primary" onClick={() => setStep("confirm")}>
                Review
              </button>
            </div>
          </div>
        )}

        {step === "confirm" && (
          <div className="card" style={{ padding: 24 }}>
            <h2 style={{ fontSize: 18 }}>Confirm your booking</h2>
            <dl style={{ fontSize: 13, display: "grid", gridTemplateColumns: "120px 1fr", gap: "6px 12px", marginTop: 12 }}>
              <dt className="muted">Name</dt><dd style={{ margin: 0 }}>{form.customer_name}</dd>
              <dt className="muted">Contact</dt><dd style={{ margin: 0 }}>{form.customer_email} · {form.customer_phone}</dd>
              <dt className="muted">Address</dt><dd style={{ margin: 0 }}>{form.address} ({form.area})</dd>
              <dt className="muted">Problem</dt><dd style={{ margin: 0 }}>{PROBLEM_CATEGORIES.find((c) => c.value === form.problem_category)?.label}</dd>
              <dt className="muted">Details</dt><dd style={{ margin: 0 }}>{form.problem_description}</dd>
              <dt className="muted">Tier</dt><dd style={{ margin: 0 }}>{TIER_META[tier].emoji} {TIER_META[tier].label} · ~{estPrice(form.problem_category, tier)} SGD</dd>
            </dl>
            {err && <p style={{ color: "var(--tier-urgent)", fontSize: 13 }}>{err}</p>}
            <div className="row" style={{ gap: 8, marginTop: 16 }}>
              <button className="btn btn-ghost" onClick={() => setStep("tier")}>Back</button>
              <button className="btn btn-primary btn-lg" disabled={busy} onClick={submit}>
                {busy ? "Submitting…" : "Confirm booking"}
              </button>
            </div>
            <p className="faint" style={{ fontSize: 11, marginTop: 10 }}>
              Our dispatch assistant then reads your request, prices it, checks the
              team's availability and matches a certified technician — you'll see each
              step as it happens. This usually takes around 15 seconds.
            </p>
          </div>
        )}

        {step === "processing" && (
          <ProcessingView
            customerEmail={form.customer_email}
            error={err}
            onRetry={() => {
              setErr(null);
              submit();
            }}
            onEditBooking={() => {
              setErr(null);
              setStep("confirm");
            }}
          />
        )}

        {step === "track" && result && (
          <TrackView result={result} />
        )}
      </div>

      <style>{`
        .inp {
          width: 100%; padding: 9px 11px; border: 1px solid var(--border-strong);
          border-radius: 8px; font-size: 13px; background: var(--surface);
        }
        .inp:focus { outline: 2px solid var(--brand-tint); border-color: var(--brand); }
      `}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block", fontSize: 12 }}>
      <span className="muted" style={{ fontWeight: 600 }}>{label}</span>
      <div style={{ marginTop: 4 }}>{children}</div>
    </label>
  );
}

function Stepper({ step }: { step: Step }) {
  const order: Step[] = ["welcome", "form", "tier", "confirm", "track"];
  const labels = ["Start", "Problem", "Speed", "Confirm", "Track"];
  // "processing" is a transient state between Confirm and Track — show it
  // as still sitting on the Confirm pill.
  const idx = order.indexOf(step === "processing" ? "confirm" : step);
  return (
    <div className="row" style={{ gap: 5, marginBottom: 24, flexWrap: "wrap" }}>
      {labels.map((l, i) => (
        <span
          key={l}
          style={{
            fontSize: 11.5,
            fontWeight: i === idx ? 600 : 400,
            color: i === idx ? "var(--text)" : "var(--text-faint)",
            background: i === idx ? "#eae7e1" : "transparent",
            border: `1px solid ${i === idx ? "var(--border-strong)" : "transparent"}`,
            borderRadius: 20,
            padding: "6px 12px",
          }}
        >
          {i + 1}. {l}
        </span>
      ))}
    </div>
  );
}

function fmtWhen(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore",
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

/** "in ~3h" / "in ~40 min" / "started" — a friendly ETA from now. */
function etaText(iso: string): string {
  const h = hoursBetween(nowISO(), iso);
  if (h <= 0) return "now / in progress";
  if (h < 1) return `in ~${Math.round(h * 60)} min`;
  if (h < 24) return `in ~${Math.round(h)}h`;
  return `in ~${Math.round(h / 24)} day${Math.round(h / 24) > 1 ? "s" : ""}`;
}

function TrackView({ result }: { result: PipelineResult }) {
  // Start from the pipeline's own result, then keep it live: the booking
  // may be rescheduled by the Disruption Agent or a coordinator after this
  // page loads, and the customer should see that without a refresh.
  const [job, setJob] = useState<Job>(result.job);
  const [tech, setTech] = useState<Technician | null>(null);
  const jobId = result.job.job_id;

  const load = useCallback(async () => {
    try {
      const { job, technician } = await apiGet<{ job: Job; technician: Technician | null }>(
        `/api/jobs/${jobId}`,
      );
      setJob(job);
      setTech(technician);
    } catch {
      /* keep last-known */
    }
  }, [jobId]);

  const conn = useRealtime("jobs", load);
  useEffect(() => {
    load();
  }, [load]);

  const j = job;
  const freezeHours = Math.max(
    0,
    Math.round(hoursBetween(j.freeze_point, j.scheduled_time)),
  );
  const rescheduled = j.reschedule_history.length > 0;

  const milestones = [
    { key: "received", label: "Request received", done: true },
    {
      key: "assigned",
      label: tech ? `Technician assigned — ${tech.name}` : "Technician assigned",
      done: ["assigned", "frozen", "in_progress", "completed"].includes(j.status),
    },
    {
      key: "locked",
      label: `Schedule locked (T−${freezeHours}h)`,
      done: ["frozen", "in_progress", "completed"].includes(j.status),
    },
    { key: "done", label: "Completed", done: j.status === "completed" },
  ];

  return (
    <div className="card" style={{ padding: 24 }}>
      <div className="spread">
        <h2 style={{ fontSize: 18, margin: 0 }}>Booking {j.job_id}</h2>
        <span className="chip">{TIER_META[j.tier].emoji} {TIER_META[j.tier].label}</span>
      </div>
      <p className="muted" style={{ fontSize: 13 }}>{result.message}</p>

      <PipelineProgress jobId={jobId} finalStatus={result.status} />

      {/* live technician + ETA card, once assigned */}
      {tech && ["assigned", "frozen", "in_progress"].includes(j.status) && (
        <div
          className="row"
          style={{
            gap: 12,
            marginTop: 12,
            padding: "12px 14px",
            borderRadius: 10,
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={tech.photo_url}
            alt={tech.name}
            width={44}
            height={44}
            style={{ borderRadius: 999, flexShrink: 0 }}
          />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{tech.name}</div>
            <div className="muted" style={{ fontSize: 12 }}>
              {tech.experience_level} · arriving {etaText(j.scheduled_time)} ({fmtWhen(j.scheduled_time)})
            </div>
          </div>
        </div>
      )}

      <div style={{ display: "grid", gap: 0, marginTop: 12 }}>
        {milestones.map((m, i) => (
          <div key={m.key} className="row" style={{ gap: 10, padding: "8px 0" }}>
            <span
              style={{
                width: 18,
                height: 18,
                borderRadius: 999,
                border: `2px solid ${m.done ? "var(--tier-flexible)" : "var(--border-strong)"}`,
                background: m.done ? "var(--tier-flexible)" : "transparent",
                color: "#fff",
                fontSize: 11,
                display: "grid",
                placeItems: "center",
                flex: "none",
              }}
            >
              {m.done ? "✓" : ""}
            </span>
            <span style={{ fontSize: 13, color: m.done ? "var(--text)" : "var(--text-faint)" }}>
              {m.label}
            </span>
            {i < milestones.length - 1 && <span style={{ flex: 1 }} />}
          </div>
        ))}
      </div>

      <dl style={{ fontSize: 12, display: "grid", gridTemplateColumns: "110px 1fr", gap: "4px 12px", marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--border)" }}>
        <dt className="muted">Scheduled</dt>
        <dd style={{ margin: 0 }}>{fmtWhen(j.scheduled_time)}</dd>
        <dt className="muted">Price</dt>
        <dd style={{ margin: 0 }}>{j.price} SGD</dd>
        <dt className="muted">Status</dt>
        <dd style={{ margin: 0 }}>{j.status.replace(/_/g, " ")}</dd>
      </dl>

      {rescheduled && (
        <p style={{ fontSize: 12, color: "var(--tier-priority)", marginTop: 10 }}>
          Your appointment was moved to fit an urgent job nearby (last change:{" "}
          {j.reschedule_history.at(-1)?.reason}). The new time is shown above.
        </p>
      )}

      {result.status === "awaiting_approval" && !rescheduled && (
        <p style={{ fontSize: 12, color: "var(--tier-priority)", marginTop: 10 }}>
          Your urgent request needs a coordinator to approve a small schedule change.
          This page updates automatically when it&apos;s confirmed.
        </p>
      )}

      <div className="row" style={{ gap: 8, marginTop: 16, flexWrap: "wrap" }}>
        <Link href="/book" className="btn" onClick={() => location.reload()}>
          Make another booking
        </Link>
        <span className="faint" style={{ fontSize: 10.5, alignSelf: "center" }}>
          {conn === "live" ? "● live" : conn === "polling" ? "○ auto-refreshing" : "connecting…"}
        </span>
      </div>
    </div>
  );
}

// ── Processing screen ──────────────────────────────────────────────
// Shown from the instant "Confirm booking" is pressed until the POST
// resolves. The pipeline runs server-side for ~10-15s on the real model;
// rather than freeze the button, we show the customer the pipeline
// *working* live. The job's skeleton row is persisted within ~200ms of
// the request starting (see agents/context.ts), so we can find it by the
// customer's email + a very recent created_at and stream its progress
// before the POST has even returned.

function ProcessingView({
  customerEmail,
  error,
  onRetry,
  onEditBooking,
}: {
  customerEmail: string;
  error: string | null;
  onRetry: () => void;
  onEditBooking: () => void;
}) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());

  // tick the elapsed clock
  useEffect(() => {
    const t = setInterval(() => setElapsed(Math.round((Date.now() - startRef.current) / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  // find the just-created job by email + recency (skeleton lands fast)
  const findJob = useCallback(async () => {
    if (jobId) return;
    try {
      const { jobs } = await apiGet<{ jobs: Job[] }>("/api/bookings");
      const mine = jobs
        .filter(
          (j) =>
            j.customer_email.toLowerCase() === customerEmail.toLowerCase() &&
            Date.now() - new Date(j.created_at).getTime() < 120_000,
        )
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      if (mine[0]) setJobId(mine[0].job_id);
    } catch {
      /* keep trying */
    }
  }, [customerEmail, jobId]);

  useRealtime("jobs", findJob);
  useEffect(() => {
    findJob();
    const t = setInterval(findJob, 1000);
    return () => clearInterval(t);
  }, [findJob]);

  if (error) {
    return (
      <div className="card" style={{ padding: 24 }}>
        <h2 style={{ fontSize: 18, margin: 0 }}>We couldn&apos;t finish your booking</h2>
        <div
          style={{
            marginTop: 12,
            padding: "12px 14px",
            borderRadius: 9,
            background: "var(--tier-urgent-bg)",
            border: "1px solid rgba(208,52,44,0.3)",
            fontSize: 13,
            color: "var(--text)",
          }}
        >
          {error}
        </div>
        <p className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>
          Nothing was charged and no technician was booked. You can try again — your
          details are still filled in.
        </p>
        <div className="row" style={{ gap: 8, marginTop: 16 }}>
          <button className="btn btn-primary" onClick={onRetry}>
            Try again
          </button>
          <button className="btn btn-ghost" onClick={onEditBooking}>
            Edit booking
          </button>
        </div>
      </div>
    );
  }

  const slow = elapsed >= 18;

  return (
    <div className="card" style={{ padding: 24 }}>
      <div className="spread" style={{ alignItems: "flex-start" }}>
        <div>
          <h2 style={{ fontSize: 18, margin: 0 }}>Setting up your booking</h2>
          <p className="muted" style={{ fontSize: 12.5, margin: "6px 0 0" }}>
            Our dispatch assistant is working on it now — this usually takes about
            15&nbsp;seconds.
          </p>
        </div>
        <span
          className="mono faint"
          style={{ fontSize: 11, whiteSpace: "nowrap", marginTop: 3 }}
        >
          {elapsed}s
        </span>
      </div>

      <div
        style={{
          marginTop: 16,
          padding: "14px 15px",
          borderRadius: 10,
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
        }}
      >
        {jobId ? (
          <PipelineProgress jobId={jobId} finalStatus={null} compact />
        ) : (
          <div className="row" style={{ gap: 10, fontSize: 12.5, color: "var(--text-muted)" }}>
            <span
              style={{
                width: 14,
                height: 14,
                borderRadius: 999,
                border: "2px solid var(--brand)",
                borderTopColor: "transparent",
                animation: "spin 0.7s linear infinite",
                flexShrink: 0,
              }}
            />
            Starting the pipeline…
          </div>
        )}
      </div>

      {slow && (
        <p
          className="muted"
          style={{
            fontSize: 12,
            marginTop: 12,
            padding: "9px 12px",
            borderRadius: 8,
            background: "var(--brand-tint)",
            border: "1px solid #bfdbfe",
          }}
        >
          Still working — thanks for your patience. Complex jobs sometimes take a
          little longer to match the right technician. This page will update the
          moment it&apos;s done.
        </p>
      )}
    </div>
  );
}

// ── Pipeline progress (customer-facing) ─────────────────────────────
// A plain-language view of the multi-agent pipeline running on this
// booking, read live from /api/decisions?job=<id>. The customer sees the
// system *working* — "Understanding your problem ✓ → Matching a
// technician ⏳" — instead of a static "please wait". Deliberately hides
// every internal detail (scores, candidate lists, rule-vs-LLM labels,
// guardrail notes); those live in the admin pipeline view.

type StepState = "done" | "active" | "waiting" | "pending";

const CUSTOMER_STEPS: {
  key: string;
  label: string;
  /** present-tense line shown while this step is running */
  active: string;
  agents: AgentDecisionLog["agent_name"][];
}[] = [
  {
    key: "intake",
    label: "Understanding your problem",
    active: "Reading your description",
    agents: ["JobIntakeAgent"],
  },
  {
    key: "price",
    label: "Confirming the price",
    active: "Working out the quote",
    agents: ["PricingEngine"],
  },
  {
    key: "capacity",
    label: "Checking team availability",
    active: "Looking at the schedule for your time slot",
    agents: ["CapacityAgent"],
  },
  {
    key: "match",
    label: "Matching a certified technician",
    active: "Comparing certified technicians by skill, distance and workload",
    agents: ["TechnicianStateAgent", "AssignmentAgent", "AssignmentTiebreakAgent", "AssignmentEdgecaseAgent"],
  },
  {
    key: "schedule",
    label: "Fitting the visit into the schedule",
    active: "Rearranging nearby jobs so a technician can reach you",
    agents: ["DisruptionAgent"],
  },
  {
    key: "confirm",
    label: "Sending your confirmation",
    active: "Writing your confirmation",
    agents: ["NotificationAgent"],
  },
];

function PipelineProgress({
  jobId,
  finalStatus,
  compact = false,
}: {
  jobId: string;
  /** null while the pipeline is still running (no result yet). */
  finalStatus: PipelineResult["status"] | null;
  /** processing screen: no card chrome, no header (the parent supplies it). */
  compact?: boolean;
}) {
  const [rows, setRows] = useState<AgentDecisionLog[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Poll faster while the pipeline is still in flight so steps light up
  // close to real time; back off once it has settled.
  const pollMs = finalStatus === null ? 1200 : 4000;

  const load = useCallback(async () => {
    try {
      const { decisions } = await apiGet<{ decisions: AgentDecisionLog[] }>(
        `/api/decisions?job=${jobId}`,
      );
      setRows(decisions);
      setLoaded(true);
    } catch {
      /* keep last */
    }
  }, [jobId]);

  useRealtime("agent_decision_log", load);
  useEffect(() => {
    load();
    const t = setInterval(load, pollMs);
    return () => clearInterval(t);
  }, [load, pollMs]);

  const seen = new Set(rows.map((r) => r.agent_name));
  const awaitingApproval =
    finalStatus === "awaiting_approval" ||
    rows.some((r) => r.requires_human_approval && r.outcome === "requires_approval");
  // A step is done once any of its agents has logged a row. The scheduling
  // step ("Fitting the visit…") is only relevant when the Disruption Agent
  // actually ran — otherwise it's skipped, not pending.
  const disruptionInvolved = seen.has("DisruptionAgent");
  const steps = CUSTOMER_STEPS.filter((s) => s.key !== "schedule" || disruptionInvolved);

  // While the booking is parked at the approvals gate, the schedule step is
  // "in a coordinator's hands" (not a finished ✓) and confirmation hasn't
  // been reached — even though the Disruption Agent has already logged its
  // proposal.
  const gateKeys = new Set(["schedule", "confirm"]);
  const doneKeys = new Set(
    steps
      .filter((s) => s.agents.some((a) => seen.has(a)))
      .filter((s) => !(awaitingApproval && gateKeys.has(s.key)))
      .map((s) => s.key),
  );
  const firstPendingIdx = steps.findIndex((s) => !doneKeys.has(s.key));

  const stateOf = (idx: number, key: string): StepState => {
    if (doneKeys.has(key)) return "done";
    if (awaitingApproval && key === "schedule") return "waiting";
    if (idx === firstPendingIdx) {
      if (awaitingApproval && gateKeys.has(key)) return "waiting";
      return "active";
    }
    return "pending";
  };

  const settled =
    finalStatus === "assigned_auto" ||
    finalStatus === "assigned_after_replan" ||
    (doneKeys.has("confirm") && !awaitingApproval);

  const body = (
    <div style={{ display: "grid", gap: 2 }}>
      {steps.map((s, idx) => {
        const st = stateOf(idx, s.key);
        return (
          <div
            key={s.key}
            className="row"
            style={{ gap: 10, padding: "6px 0", alignItems: "flex-start" }}
          >
            <div style={{ marginTop: 1 }}>
              <StepMark state={st} />
            </div>
            <span
              style={{
                fontSize: 12.5,
                lineHeight: 1.45,
                color: st === "pending" ? "var(--text-faint)" : "var(--text)",
                fontWeight: st === "active" || st === "waiting" ? 600 : 400,
              }}
            >
              {s.label}
              {st === "waiting" && (
                <span className="muted" style={{ fontWeight: 400, display: "block", marginTop: 1 }}>
                  A coordinator is confirming a small schedule change — nothing more
                  for you to do.
                </span>
              )}
              {st === "active" && (
                <span className="muted" style={{ fontWeight: 400, display: "block", marginTop: 1 }}>
                  {s.active}…
                </span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );

  if (compact) {
    return (
      <div>
        {body}
        {!loaded && (
          <div className="faint" style={{ fontSize: 10.5, marginTop: 8 }}>
            connecting…
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      style={{
        marginTop: 14,
        padding: "13px 15px",
        borderRadius: 10,
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
      }}
    >
      <div
        className="row"
        style={{ gap: 8, justifyContent: "space-between", marginBottom: 10 }}
      >
        <strong style={{ fontSize: 12.5 }}>
          {settled ? "How we set up your booking" : "Setting up your booking…"}
        </strong>
        {!loaded && <span className="faint" style={{ fontSize: 10.5 }}>loading…</span>}
      </div>
      {body}
    </div>
  );
}

function StepMark({ state }: { state: StepState }) {
  const base = {
    width: 16,
    height: 16,
    borderRadius: 999,
    flexShrink: 0,
    display: "grid",
    placeItems: "center",
    fontSize: 10,
  } as const;
  if (state === "done") {
    return <span style={{ ...base, background: "var(--tier-flexible)", color: "#fff" }}>✓</span>;
  }
  if (state === "active") {
    return (
      <span
        style={{
          ...base,
          border: "2px solid var(--brand)",
          background: "var(--brand-tint)",
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: "var(--brand)",
            animation: "pulse 1.4s ease-in-out infinite",
          }}
        />
      </span>
    );
  }
  if (state === "waiting") {
    return (
      <span style={{ ...base, border: "2px solid var(--tier-priority)", color: "var(--tier-priority)" }}>
        ⏸
      </span>
    );
  }
  return <span style={{ ...base, border: "2px solid var(--border-strong)" }} />;
}
