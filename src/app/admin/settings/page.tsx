"use client";

import { useEffect, useState } from "react";
import { apiGet, apiSend } from "@/lib/client";
import { Toast } from "@/components/ui";
import { SKILL_LABEL, SKILL_TAGS, type RuntimeConfig } from "@/lib/types";

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
      setToast({ msg: "Settings saved. New bookings use these values immediately.", kind: "success" });
    } catch (e) {
      setToast({ msg: (e as Error).message, kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  function set<K extends keyof RuntimeConfig>(k: K, v: RuntimeConfig[K]) {
    setDraft((d) => (d ? { ...d, [k]: v } : d));
  }

  return (
    <div className="stack" style={{ gap: 18, maxWidth: 720 }}>
      <div>
        <h1 style={{ fontSize: 22, margin: 0 }}>Settings</h1>
        <p className="muted" style={{ margin: "2px 0 0", fontSize: 13 }}>
          Every rule the agents use is here — nothing is hidden in code. This is the
          observability surface for how decisions get made.
        </p>
      </div>

      <Section title="Freeze window" hint="Hours before the appointment when the schedule locks. After this point, only an Emergency Override (with coordinator approval) can change the job.">
        <NumberField
          label="freezeWindowHours"
          value={draft.freezeWindowHours}
          min={0.5}
          max={24}
          step={0.5}
          onChange={(v) => set("freezeWindowHours", v)}
          unit="h"
        />
      </Section>

      <Section
        title="Scoring weights"
        hint="score = w1·(1/distance) + w2·skill_match + w3·urgency + w4·(1/workload). Raise w1 to favour nearby technicians, w3 to push urgent jobs harder, etc."
      >
        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
          {(["w1", "w2", "w3", "w4"] as const).map((w) => (
            <NumberField
              key={w}
              label={`${w} ${
                { w1: "distance", w2: "skill", w3: "urgency", w4: "workload" }[w]
              }`}
              value={draft.scoreWeights[w]}
              min={0}
              max={10}
              step={0.1}
              onChange={(v) => set("scoreWeights", { ...draft.scoreWeights, [w]: v })}
            />
          ))}
        </div>
      </Section>

      <Section
        title="Human-in-the-loop thresholds"
        hint="A re-plan auto-commits only if it stays under all of these. Otherwise it goes to the Approvals queue. Set customers to 0 to review every customer-visible move."
      >
        <NumberField
          label="hitlMaxCustomersAffected"
          value={draft.hitlMaxCustomersAffected}
          min={0}
          max={20}
          step={1}
          onChange={(v) => set("hitlMaxCustomersAffected", v)}
        />
        <NumberField
          label="hitlMaxAddedTravelKm"
          value={draft.hitlMaxAddedTravelKm}
          min={0}
          max={100}
          step={1}
          onChange={(v) => set("hitlMaxAddedTravelKm", v)}
          unit="km"
        />
      </Section>

      <Section title="Capacity caps" hint="Hard limits the Capacity Agent enforces per day.">
        <NumberField
          label="capacityFlexiblePerDay"
          value={draft.capacityFlexiblePerDay}
          min={0}
          max={100}
          step={1}
          onChange={(v) => set("capacityFlexiblePerDay", v)}
        />
        <NumberField
          label="capacityTotalPerDay"
          value={draft.capacityTotalPerDay}
          min={1}
          max={500}
          step={1}
          onChange={(v) => set("capacityTotalPerDay", v)}
        />
      </Section>

      <Section title="Base price by skill (SGD)" hint="Tier multipliers are applied on top: Urgent ×1.75, Priority ×1.25, Standard ×1.0, Flexible ×0.85.">
        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
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
      </Section>

      <Section title="LLM mode" hint="stub = deterministic fixtures, no API calls. bedrock = live Claude Sonnet 4.5 on AWS Bedrock. openai = OpenAI Chat Completions.">
        <div className="row" style={{ gap: 8 }}>
          {(["stub", "bedrock", "openai"] as const).map((m) => (
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
          <span className="faint" style={{ fontSize: 11 }}>
            (also set the LLM_MODE env var on the server)
          </span>
        </div>
      </Section>

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

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card" style={{ padding: 16 }}>
      <strong style={{ fontSize: 13 }}>{title}</strong>
      <p className="muted" style={{ fontSize: 12, margin: "4px 0 12px" }}>
        {hint}
      </p>
      <div className="stack" style={{ gap: 10 }}>
        {children}
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
      <span className="mono" style={{ fontSize: 11 }}>{label}</span>
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
