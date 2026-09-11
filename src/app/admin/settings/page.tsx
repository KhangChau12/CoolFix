"use client";

import { useEffect, useState } from "react";
import { apiGet, apiSend } from "@/lib/client";
import { Toast } from "@/components/ui";
import { ScoringExplainer, SCORING_COMPONENTS } from "@/components/scoring";
import {
  DISPATCH_POLICY,
  SCORE_COMPONENTS,
  SCORE_COMPONENT_LABEL,
  SKILL_LABEL,
  SKILL_TAGS,
  TIERS,
  TIER_META,
  TIER_SLA_TEXT,
  type RuntimeConfig,
  type ScoreComponent,
  type Tier,
} from "@/lib/types";

// ── Per-tier presets — a starting point a coordinator can reason about,
//    then fine-tune. Each sums to 1.
const POLICY_PRESETS: Record<
  string,
  { label: string; blurb: string; weights: Record<ScoreComponent, number> }
> = {
  speed: {
    label: "Speed first",
    blurb: "Nearest capable technician, fast. Best for urgent work.",
    weights: { travel: 0.45, skillFit: 0.28, availability: 0.12, slaHeadroom: 0.15, loadBalance: 0.0 },
  },
  balanced: {
    label: "Balanced",
    blurb: "Trade travel against a sustainable, even day across the roster.",
    weights: { travel: 0.3, skillFit: 0.24, availability: 0.16, slaHeadroom: 0.1, loadBalance: 0.2 },
  },
  fair: {
    label: "Spread the load",
    blurb: "Push work to under-loaded technicians. Best for flexible, non-urgent jobs.",
    weights: { travel: 0.2, skillFit: 0.18, availability: 0.18, slaHeadroom: 0.02, loadBalance: 0.42 },
  },
};

function matchPreset(w: Record<ScoreComponent, number>): string | null {
  for (const [key, p] of Object.entries(POLICY_PRESETS)) {
    if (SCORE_COMPONENTS.every((k) => Math.abs((w[k] ?? 0) - p.weights[k]) < 0.015)) {
      return key;
    }
  }
  return null;
}

export default function SettingsPage() {
  const [cfg, setCfg] = useState<RuntimeConfig | null>(null);
  const [draft, setDraft] = useState<RuntimeConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; kind: "success" | "error" } | null>(null);

  useEffect(() => {
    apiGet<{ config: RuntimeConfig }>("/api/config").then(({ config }) => {
      setCfg(config);
      setDraft(config);
    });
  }, []);

  if (!draft) return <div className="muted">Loading settings…</div>;

  const dirty = JSON.stringify(cfg) !== JSON.stringify(draft);

  async function save() {
    setBusy(true);
    try {
      const { config } = await apiSend<{ config: RuntimeConfig }>("/api/config", "PATCH", draft);
      setCfg(config);
      setDraft(config);
      setToast({ msg: "Saved. Every booking from now on uses these rules.", kind: "success" });
    } catch (e) {
      setToast({ msg: (e as Error).message, kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  function set<K extends keyof RuntimeConfig>(k: K, v: RuntimeConfig[K]) {
    setDraft((d) => (d ? { ...d, [k]: v } : d));
  }

  function setPolicy(tier: Tier, k: ScoreComponent, v: number) {
    setDraft((d) =>
      d
        ? {
            ...d,
            dispatchPolicy: {
              ...d.dispatchPolicy,
              [tier]: { ...d.dispatchPolicy[tier], [k]: v },
            },
          }
        : d,
    );
  }

  function setPolicyRow(tier: Tier, weights: Record<ScoreComponent, number>) {
    setDraft((d) =>
      d ? { ...d, dispatchPolicy: { ...d.dispatchPolicy, [tier]: { ...weights } } } : d,
    );
  }

  return (
    <div className="stack" style={{ gap: 20, maxWidth: 780 }}>
      <div>
        <h1 style={{ fontSize: 22, margin: 0 }}>Settings — the rulebook the agents run on</h1>
        <p className="muted" style={{ margin: "4px 0 0", fontSize: 13, lineHeight: 1.55 }}>
          Nothing here is hidden in code. Every number below is a business decision the
          coordinator owns: how the system picks a technician, when it acts on its own
          versus asking a human, how many jobs a day the fleet takes, and what a visit
          costs. Change one and the very next booking uses it.
        </p>
      </div>

      {/* ── Dispatch policy — the big one ── */}
      <div className="card" style={{ padding: 18 }}>
        <div style={{ marginBottom: 4 }}>
          <strong style={{ fontSize: 14 }}>Dispatch policy — how a technician is chosen</strong>
        </div>
        <p className="muted" style={{ fontSize: 12.5, margin: "4px 0 14px", lineHeight: 1.55 }}>
          For every booking, the Assignment Agent first removes anyone who can&apos;t legally
          or physically do the job (wrong certification, off-shift, already booked, can&apos;t
          reach it in time), then scores everyone left on five things and picks the best
          match. You decide how much each of the five counts — and you can set that
          differently for each service tier.
        </p>

        <details style={{ marginBottom: 16 }}>
          <summary
            className="mono"
            style={{ fontSize: 11, color: "var(--brand)", cursor: "pointer" }}
          >
            Show the formula and what each component means →
          </summary>
          <div
            style={{
              marginTop: 12,
              padding: 14,
              borderRadius: 8,
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
            }}
          >
            <ScoringExplainer />
          </div>
        </details>

        <div className="stack" style={{ gap: 14 }}>
          {TIERS.map((tier) => (
            <PolicyTierCard
              key={tier}
              tier={tier}
              row={draft.dispatchPolicy[tier]}
              onComponent={(k, v) => setPolicy(tier, k, v)}
              onPreset={(w) => setPolicyRow(tier, w)}
              onReset={() => setPolicyRow(tier, DISPATCH_POLICY[tier])}
            />
          ))}
        </div>
      </div>

      {/* ── Autonomy / HITL ── */}
      <div className="card" style={{ padding: 18 }}>
        <strong style={{ fontSize: 14 }}>Autonomy — when the system acts without asking</strong>
        <p className="muted" style={{ fontSize: 12.5, margin: "4px 0 14px", lineHeight: 1.55 }}>
          When an urgent job forces an existing appointment to move, the Disruption Agent
          designs a re-plan. It only commits that re-plan on its own if the impact is
          genuinely small — otherwise it stops and puts it on the Approvals queue for a
          coordinator. These two numbers are the ceiling on &quot;small&quot;. On top of them
          the system always enforces fixed safety rails: only a Flexible-tier job moves
          automatically, same day, ≤3h shift, ≥2h gap to the next job, no SLA breach, and
          never a customer who was already rescheduled once.
        </p>
        <ExplainedField
          label="Max customers a re-plan can move on its own"
          field="hitlMaxCustomersAffected"
          value={draft.hitlMaxCustomersAffected}
          min={0}
          max={10}
          step={1}
          onChange={(v) => set("hitlMaxCustomersAffected", v)}
          low="0 = a human reviews every customer-visible schedule change."
          high="Higher = the system reshuffles more of the day silently. Rarely worth going above 1."
        />
        <ExplainedField
          label="Max extra travel a re-plan can add on its own"
          field="hitlMaxAddedTravelKm"
          value={draft.hitlMaxAddedTravelKm}
          min={0}
          max={40}
          step={1}
          unit="km"
          onChange={(v) => set("hitlMaxAddedTravelKm", v)}
          low="Low = even a small detour goes to a human."
          high="High = the system will accept longer drives to avoid asking. Costs fuel and punctuality."
        />
      </div>

      {/* ── Freeze window ── */}
      <div className="card" style={{ padding: 18 }}>
        <strong style={{ fontSize: 14 }}>Freeze window — when a booking becomes untouchable</strong>
        <p className="muted" style={{ fontSize: 12.5, margin: "4px 0 14px", lineHeight: 1.55 }}>
          This many hours before the appointment, the job locks. After that the automatic
          pipeline treats it as already happening — no agent, not even under an urgent
          request, will propose moving it. (A coordinator can still hand-edit a locked job
          in a real emergency; the agents just never suggest it.)
        </p>
        <ExplainedField
          label="Freeze window"
          field="freezeWindowHours"
          value={draft.freezeWindowHours}
          min={0.5}
          max={24}
          step={0.5}
          unit="h"
          onChange={(v) => set("freezeWindowHours", v)}
          low="Short = the system keeps flexibility to re-plan closer to the appointment, but customers get less notice of a change."
          high="Long = customers are protected earlier, but an urgent job late in the day has fewer legal moves and is more likely to be turned away."
        />
      </div>

      {/* ── Capacity ── */}
      <div className="card" style={{ padding: 18 }}>
        <strong style={{ fontSize: 14 }}>Capacity — how much work a day can hold</strong>
        <p className="muted" style={{ fontSize: 12.5, margin: "4px 0 14px", lineHeight: 1.55 }}>
          Hard daily ceilings the Capacity Agent checks before accepting a booking. Hit the
          total and new non-urgent bookings are offered a later day; hit the Flexible cap
          and only higher tiers get through.
        </p>
        <ExplainedField
          label="Flexible-tier jobs per day"
          field="capacityFlexiblePerDay"
          value={draft.capacityFlexiblePerDay}
          min={0}
          max={40}
          step={1}
          onChange={(v) => set("capacityFlexiblePerDay", v)}
          low="Low = protect the day for jobs that pay a premium."
          high="High = fill the fleet with cheap flexible work; less room for a late urgent call."
        />
        <ExplainedField
          label="Total jobs per day (whole fleet)"
          field="capacityTotalPerDay"
          value={draft.capacityTotalPerDay}
          min={1}
          max={120}
          step={1}
          onChange={(v) => set("capacityTotalPerDay", v)}
          low="Low = a comfortable day with slack to absorb disruptions."
          high="High = maximum utilisation, minimum buffer — one sick call cascades."
        />
      </div>

      {/* ── Pricing ── */}
      <div className="card" style={{ padding: 18 }}>
        <strong style={{ fontSize: 14 }}>Base price by skill (SGD)</strong>
        <p className="muted" style={{ fontSize: 12.5, margin: "4px 0 12px", lineHeight: 1.55 }}>
          The Pricing Engine takes the base price for the skill the job actually needs and
          multiplies by the tier: Urgent ×1.75, Priority ×1.25, Standard ×1.0, Flexible
          ×0.85. Rule-based — no LLM touches the price.
        </p>
        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {SKILL_TAGS.map((s) => (
            <NumberField
              key={s}
              label={SKILL_LABEL[s]}
              value={draft.basePrice[s]}
              min={0}
              max={2000}
              step={10}
              onChange={(v) => set("basePrice", { ...draft.basePrice, [s]: v })}
              unit="$"
            />
          ))}
        </div>
      </div>

      {/* ── LLM mode ── */}
      <div className="card" style={{ padding: 18 }}>
        <strong style={{ fontSize: 14 }}>Reasoning engine</strong>
        <p className="muted" style={{ fontSize: 12.5, margin: "4px 0 12px", lineHeight: 1.55 }}>
          Which model backs the four LLM agents (Job-Intake, Disruption, Tie-break,
          Edge-case, Notification). The rule engines — Pricing, Capacity, Technician-State,
          Assignment scoring — never call a model regardless.
        </p>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {(["stub", "gateway", "openai"] as const).map((m) => (
            <button
              key={m}
              className="chip"
              style={{
                cursor: "pointer",
                background: draft.llmMode === m ? "var(--brand)" : "var(--surface-2)",
                color: draft.llmMode === m ? "#fff" : "var(--text-muted)",
                borderColor: draft.llmMode === m ? "var(--brand)" : "var(--border)",
              }}
              onClick={() => set("llmMode", m)}
            >
              {m}
            </button>
          ))}
        </div>
        <p className="faint" style={{ fontSize: 11, margin: "8px 0 0", lineHeight: 1.5 }}>
          stub = deterministic fixtures, no API calls · gateway = live Claude Sonnet 4.5 via
          the hackathon&apos;s AWS LLM gateway · openai = OpenAI Chat Completions (dev
          fallback). Also set the <code className="mono">LLM_MODE</code> env var on the
          server.
        </p>
      </div>

      <div
        className="row"
        style={{
          gap: 10,
          position: "sticky",
          bottom: 0,
          padding: "12px 0",
          background: "linear-gradient(transparent, var(--bg) 40%)",
        }}
      >
        <button className="btn btn-primary" disabled={!dirty || busy} onClick={save}>
          {busy ? "Saving…" : dirty ? "Save changes" : "Saved"}
        </button>
        {dirty && (
          <button className="btn btn-ghost" onClick={() => setDraft(cfg)}>
            Discard
          </button>
        )}
      </div>

      {toast && <Toast message={toast.msg} kind={toast.kind} onClose={() => setToast(null)} />}
    </div>
  );
}

// ── One tier's dispatch policy: preset chips + a stacked-bar view of the
//    mix + fine sliders per component with a one-line reminder of each.
function PolicyTierCard({
  tier,
  row,
  onComponent,
  onPreset,
  onReset,
}: {
  tier: Tier;
  row: Record<ScoreComponent, number>;
  onComponent: (k: ScoreComponent, v: number) => void;
  onPreset: (w: Record<ScoreComponent, number>) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const sum = SCORE_COMPONENTS.reduce((s, k) => s + (row[k] ?? 0), 0);
  const off = Math.abs(sum - 1) > 0.005;
  const active = matchPreset(row);
  const compColor: Record<ScoreComponent, string> = {
    travel: "#3d68b0",
    skillFit: "#6b8e23",
    availability: "#c98a3c",
    slaHeadroom: "#b0453b",
    loadBalance: "#5a7d9a",
  };
  const meta = SCORING_COMPONENTS.reduce(
    (m, c) => ({ ...m, [c.key]: c }),
    {} as Record<string, (typeof SCORING_COMPONENTS)[number]>,
  );

  return (
    <div className="card" style={{ padding: 14, background: "var(--surface-2)" }}>
      <div className="spread" style={{ marginBottom: 10, alignItems: "baseline" }}>
        <div>
          <strong style={{ fontSize: 13 }}>
            {TIER_META[tier].emoji} {TIER_META[tier].label}
          </strong>
          <span className="faint" style={{ fontSize: 11, marginLeft: 8 }}>
            SLA {TIER_SLA_TEXT[tier]}
          </span>
        </div>
        <span
          className="mono"
          style={{ fontSize: 10.5, color: off ? "#b0453b" : "var(--text-faint)" }}
        >
          Σ {sum.toFixed(2)}
          {off ? " → normalised on save" : ""}
        </span>
      </div>

      {/* stacked bar of the current mix */}
      <div
        style={{
          display: "flex",
          height: 10,
          borderRadius: 5,
          overflow: "hidden",
          border: "1px solid var(--border)",
          marginBottom: 8,
        }}
        title={SCORE_COMPONENTS.map(
          (k) => `${SCORE_COMPONENT_LABEL[k]} ${Math.round(((row[k] ?? 0) / (sum || 1)) * 100)}%`,
        ).join(" · ")}
      >
        {SCORE_COMPONENTS.map((k) => (
          <div
            key={k}
            style={{
              width: `${((row[k] ?? 0) / (sum || 1)) * 100}%`,
              background: compColor[k],
            }}
          />
        ))}
      </div>

      {/* preset chips */}
      <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
        {Object.entries(POLICY_PRESETS).map(([key, p]) => (
          <button
            key={key}
            className="chip"
            title={p.blurb}
            style={{
              cursor: "pointer",
              fontSize: 11,
              background: active === key ? "var(--brand)" : "var(--surface)",
              color: active === key ? "#fff" : "var(--text-muted)",
              borderColor: active === key ? "var(--brand)" : "var(--border)",
            }}
            onClick={() => onPreset(p.weights)}
          >
            {p.label}
          </button>
        ))}
        <button
          className="chip"
          style={{ cursor: "pointer", fontSize: 11, background: "var(--surface)" }}
          onClick={onReset}
        >
          Reset to default
        </button>
        <button
          className="chip"
          style={{ cursor: "pointer", fontSize: 11, background: "var(--surface)" }}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "Hide sliders" : "Fine-tune ▾"}
        </button>
      </div>

      {open && (
        <div className="stack" style={{ gap: 9, marginTop: 8 }}>
          {SCORE_COMPONENTS.map((k) => (
            <div key={k}>
              <div className="spread" style={{ alignItems: "baseline" }}>
                <span style={{ fontSize: 11.5, fontWeight: 600 }}>
                  <span
                    style={{
                      display: "inline-block",
                      width: 8,
                      height: 8,
                      borderRadius: 2,
                      background: compColor[k],
                      marginRight: 6,
                    }}
                  />
                  {SCORE_COMPONENT_LABEL[k]}
                </span>
                <span className="mono faint" style={{ fontSize: 10 }}>
                  {(row[k] ?? 0).toFixed(2)}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={row[k] ?? 0}
                onChange={(e) => onComponent(k, Number(e.target.value))}
                style={{ width: "100%", accentColor: compColor[k] }}
              />
              <div className="faint" style={{ fontSize: 10.5, lineHeight: 1.45 }}>
                {meta[k]?.measures}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ExplainedField({
  label,
  field,
  value,
  min,
  max,
  step,
  unit,
  onChange,
  low,
  high,
}: {
  label: string;
  field: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (v: number) => void;
  low: string;
  high: string;
}) {
  return (
    <div style={{ padding: "10px 0", borderTop: "1px solid var(--border)" }}>
      <div className="spread" style={{ alignItems: "baseline", marginBottom: 6 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>{label}</span>
        <span className="mono faint" style={{ fontSize: 10 }}>
          {field}
        </span>
      </div>
      <div className="row" style={{ gap: 10 }}>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{ flex: 1, accentColor: "var(--brand)" }}
        />
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="btn"
          style={{ width: 80, fontWeight: 400 }}
        />
        {unit && <span className="faint" style={{ width: 16 }}>{unit}</span>}
      </div>
      <div
        className="grid"
        style={{ gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 6 }}
      >
        <div className="faint" style={{ fontSize: 10.5, lineHeight: 1.45 }}>
          ↓ {low}
        </div>
        <div className="faint" style={{ fontSize: 10.5, lineHeight: 1.45 }}>
          ↑ {high}
        </div>
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (v: number) => void;
}) {
  return (
    <label style={{ fontSize: 12, display: "block" }}>
      <span className="mono" style={{ fontSize: 11 }}>
        {label}
      </span>
      <span className="row" style={{ gap: 8, marginTop: 4 }}>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{ flex: 1, accentColor: "var(--brand)" }}
        />
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="btn"
          style={{ width: 84, fontWeight: 400 }}
        />
        {unit && <span className="faint" style={{ width: 16 }}>{unit}</span>}
      </span>
    </label>
  );
}
