"use client";

import { useState } from "react";
import Link from "next/link";
import { apiSend } from "@/lib/client";
import { TopBar } from "@/components/TopBar";
import { SG_LANDMARKS } from "@/lib/geo";
import {
  PROBLEM_CATEGORIES,
  TIER_META,
  TIERS,
  TIER_SLA_TEXT,
  DEFAULT_CONFIG,
  CATEGORY_HINT_SKILL,
  type Tier,
} from "@/lib/types";
import type { PipelineResult } from "@/agents/orchestrator";

type Step = "welcome" | "form" | "tier" | "confirm" | "track";

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
              On submit, the multi-agent pipeline runs: pricing → intake → capacity →
              scoring → assignment (and disruption handling if needed).
            </p>
          </div>
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
  const idx = order.indexOf(step);
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

function TrackView({ result }: { result: PipelineResult }) {
  const j = result.job;
  const milestones = [
    { key: "received", label: "Request received", done: true },
    {
      key: "assigned",
      label: "Technician assigned",
      done: ["assigned", "frozen", "in_progress", "completed"].includes(j.status),
    },
    {
      key: "locked",
      label: "Schedule locked (T−3h)",
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
        <dd style={{ margin: 0 }}>
          {new Intl.DateTimeFormat("en-GB", {
            timeZone: "Asia/Singapore",
            weekday: "short",
            day: "2-digit",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }).format(new Date(j.scheduled_time))}
        </dd>
        <dt className="muted">Price</dt>
        <dd style={{ margin: 0 }}>{j.price} SGD</dd>
        <dt className="muted">Status</dt>
        <dd style={{ margin: 0 }}>{result.status.replace(/_/g, " ")}</dd>
      </dl>

      {result.status === "awaiting_approval" && (
        <p style={{ fontSize: 12, color: "var(--tier-priority)", marginTop: 10 }}>
          Your urgent request needs a coordinator to approve a small schedule change.
          You'll be notified shortly.
        </p>
      )}

      <Link href="/book" className="btn" style={{ marginTop: 16 }} onClick={() => location.reload()}>
        Make another booking
      </Link>
    </div>
  );
}
