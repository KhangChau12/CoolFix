"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiSend } from "@/lib/client";
import { Toast } from "@/components/ui";
import {
  SCORE_COMPONENTS,
  SCORE_COMPONENT_LABEL,
  TIERS,
  TIER_META,
  type AdaptiveModeAnalysis,
  type AdaptivePolicyRecommendation,
  type AdaptivePolicyChangeHistory,
  type RuntimeConfig,
  type Tier,
} from "@/lib/types";

type CompanyData = {
  companyId: string;
  demoScope: boolean;
  config: RuntimeConfig;
  analyses: AdaptiveModeAnalysis[];
  recommendations: AdaptivePolicyRecommendation[];
  history: AdaptivePolicyChangeHistory[];
};

export default function CompanyPage() {
  const [data, setData] = useState<CompanyData | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; kind: "success" | "error" } | null>(null);

  const load = useCallback(async () => {
    try { setData(await apiGet<CompanyData>("/api/admin/adaptive-policy")); }
    catch (error) { setToast({ msg: (error as Error).message, kind: "error" }); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function analyze() {
    setBusy("analyze");
    try {
      await apiSend("/api/admin/adaptive-policy", "POST");
      await load();
      setToast({ msg: "Analysis complete. Any safe recommendation is waiting for review.", kind: "success" });
    } catch (error) { setToast({ msg: (error as Error).message, kind: "error" }); }
    finally { setBusy(null); }
  }

  async function action(recommendation: AdaptivePolicyRecommendation, verb: "approve" | "reject" | "apply" | "rollback") {
    setBusy(`${verb}:${recommendation.recommendation_id}`);
    try {
      await apiSend(`/api/admin/adaptive-policy/${recommendation.recommendation_id}/${verb}`, "POST", { actor: "demo coordinator" });
      await load();
      setToast({ msg: `Recommendation ${verb === "rollback" ? "rolled back" : `${verb}d`}.`, kind: "success" });
    } catch (error) { setToast({ msg: (error as Error).message, kind: "error" }); }
    finally { setBusy(null); }
  }

  if (!data) return <div className="muted">Loading company policy…</div>;
  const analysisByTier = new Map(data.analyses.map((item) => [item.tier, item]));
  const pending = data.recommendations.filter((item) => item.status === "pending");

  return (
    <div className="stack" style={{ gap: 20, maxWidth: 1080 }}>
      <div className="spread" style={{ alignItems: "flex-start", gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 22, margin: 0 }}>Company — dispatch policy feedback loop</h1>
          <p className="muted" style={{ margin: "5px 0 0", fontSize: 13, lineHeight: 1.55 }}>
            Scope: <span className="mono">{data.companyId}</span> · policy version <span className="mono">{data.config.policyVersion}</span>
          </p>
        </div>
        <button className="btn btn-primary" disabled={busy === "analyze"} onClick={analyze}>
          {busy === "analyze" ? "Analyzing…" : "Analyze feedback"}
        </button>
      </div>

      <div className="card" style={{ padding: 14, borderColor: "#d6c98d", background: "#fffdf0" }}>
        <strong style={{ fontSize: 12.5 }}>Demo company scope</strong>
        <p style={{ margin: "4px 0 0", fontSize: 12, lineHeight: 1.5 }}>
          This repository does not yet have authentication, a company table, or production tenant isolation.
          Recommendations are therefore scoped to the clearly named demo company. Add authenticated company
          identity before enabling this for multiple real companies.
        </p>
      </div>

      <div className="card" style={{ padding: 18 }}>
        <div className="spread" style={{ marginBottom: 12 }}>
          <strong style={{ fontSize: 14 }}>Current company-level policy</strong>
          <span className="pill-count">{data.config.adaptivePolicy.enabled ? (data.config.adaptivePolicy.mode === "automatic" ? "automatic opt-in" : "recommendation only") : "disabled"}</span>
        </div>
        <div className="grid" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
          {TIERS.map((tier) => <PolicyCard key={tier} tier={tier} config={data.config} analysis={analysisByTier.get(tier)} />)}
        </div>
      </div>

      <div className="card" style={{ padding: 18 }}>
        <div className="spread" style={{ marginBottom: 4 }}>
          <strong style={{ fontSize: 14 }}>Adaptive recommendations</strong>
          <span className="faint" style={{ fontSize: 11 }}>{pending.length} pending review</span>
        </div>
        <p className="muted" style={{ fontSize: 12, lineHeight: 1.5, margin: "4px 0 14px" }}>
          Suggestions are based on validated ratings and fixed tags only. They describe observed correlation,
          not proof that changing routing weights will cause the improvement.
        </p>
        {data.recommendations.length === 0 ? <p className="faint" style={{ fontSize: 12 }}>No stored recommendations yet. Run an analysis after enough completed jobs have feedback.</p> : (
          <div className="stack" style={{ gap: 10 }}>
            {data.recommendations.map((recommendation) => (
              <RecommendationCard key={recommendation.recommendation_id} recommendation={recommendation} busy={busy} onAction={action} />
            ))}
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 18 }}>
        <strong style={{ fontSize: 14 }}>Policy change history</strong>
        {data.history.length === 0 ? <p className="faint" style={{ fontSize: 12 }}>No policy changes have been applied.</p> : (
          <div className="stack" style={{ gap: 8, marginTop: 10 }}>
            {data.history.map((change) => <div key={change.change_id} style={{ borderTop: "1px solid var(--border)", paddingTop: 8, fontSize: 12 }}><div className="spread"><span><strong>{change.tier}</strong> · {change.change_mode}</span><span className="mono faint">{new Date(change.created_at).toLocaleString()}</span></div><div className="muted" style={{ marginTop: 3 }}>{change.reason}</div></div>)}
          </div>
        )}
      </div>
      {toast && <Toast message={toast.msg} kind={toast.kind} onClose={() => setToast(null)} />}
    </div>
  );
}

function PolicyCard({ tier, config, analysis }: { tier: Tier; config: RuntimeConfig; analysis?: AdaptiveModeAnalysis }) {
  const policy = config.dispatchPolicy[tier];
  return <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12 }}>
    <div className="spread"><strong style={{ color: `var(${TIER_META[tier].colorVar})`, fontSize: 13 }}>{TIER_META[tier].label}</strong><span className="mono faint" style={{ fontSize: 10 }}>v {config.policyVersion}</span></div>
    <div className="stack" style={{ gap: 4, marginTop: 10 }}>
      {SCORE_COMPONENTS.map((component) => <div className="spread" key={component} style={{ fontSize: 11.5 }}><span>{SCORE_COMPONENT_LABEL[component]}</span><span className="mono">{(policy[component] ?? 0).toFixed(3)}</span></div>)}
    </div>
    <div className="faint" style={{ fontSize: 11, marginTop: 10 }}>Feedback: {analysis?.sampleCount ?? 0} records · {analysis ? `${analysis.smoothedRating.toFixed(2)} / 5 smoothed` : "not analyzed"}</div>
    {analysis?.improvementTags.length ? <div className="faint" style={{ fontSize: 11, marginTop: 3 }}>Improvement tags: {analysis.improvementTags.map((tag) => `${tag.tag} (${tag.count})`).join(", ")}</div> : null}
    <div className="faint" style={{ fontSize: 11, marginTop: 3 }}>Recommendation: {analysis?.recommendation?.status ?? "none"}</div>
  </div>;
}

function RecommendationCard({ recommendation, busy, onAction }: { recommendation: AdaptivePolicyRecommendation; busy: string | null; onAction: (r: AdaptivePolicyRecommendation, action: "approve" | "reject" | "apply" | "rollback") => void }) {
  return <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 13 }}>
    <div className="spread" style={{ alignItems: "baseline" }}><strong style={{ fontSize: 13 }}>{recommendation.tier} · {recommendation.status}</strong><span className="mono faint" style={{ fontSize: 10 }}>{Math.round(recommendation.confidence * 100)}% confidence · {recommendation.sample_count} records · {recommendation.unique_technician_count} technicians</span></div>
    <p style={{ fontSize: 12, lineHeight: 1.5, margin: "8px 0" }}>{recommendation.explanation}</p>
    <div className="stack" style={{ gap: 3, marginBottom: 9 }}>{recommendation.changes.map((change) => <div key={change.component} className="mono" style={{ fontSize: 11 }}>{SCORE_COMPONENT_LABEL[change.component]}: {change.oldWeight.toFixed(3)} → {change.newWeight.toFixed(3)} ({change.delta >= 0 ? "+" : ""}{change.delta.toFixed(3)})</div>)}</div>
    <div className="faint" style={{ fontSize: 10.5, lineHeight: 1.45 }}>Included feedback: {recommendation.included_feedback_ids.length} · excluded: {recommendation.excluded_feedback_ids.length}. Previous policy version: {recommendation.previous_policy_version}.</div>
    <div className="row" style={{ gap: 7, marginTop: 11, flexWrap: "wrap" }}>
      {recommendation.status === "pending" && <><button className="btn btn-primary" disabled={busy != null} onClick={() => onAction(recommendation, "approve")}>Approve</button><button className="btn btn-ghost" disabled={busy != null} onClick={() => onAction(recommendation, "reject")}>Reject</button></>}
      {recommendation.status === "approved" && <button className="btn btn-primary" disabled={busy != null} onClick={() => onAction(recommendation, "apply")}>Apply to future assignments</button>}
      {recommendation.status === "applied" && <button className="btn btn-ghost" disabled={busy != null} onClick={() => onAction(recommendation, "rollback")}>Rollback exact snapshot</button>}
    </div>
  </div>;
}
