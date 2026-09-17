// ── Adaptive dispatch policy ─────────────────────────────────────────
// This module is intentionally deterministic. Customer ratings and fixed
// tags may produce a recommendation, never a direct config mutation. The
// caller must persist it and a coordinator (or explicitly enabled automatic
// mode) must pass the optimistic policy-version check before applying it.

import * as repo from "./repo";
import {
  FEEDBACK_IMPROVEMENT_TAGS,
  FEEDBACK_POSITIVE_TAGS,
  SCORE_COMPONENTS,
  type AdaptivePolicyRecommendation,
  type AdaptivePolicySettings,
  type AdaptivePolicyChange,
  type AdaptiveModeAnalysis,
  type DispatchPolicy,
  type Job,
  type JobFeedback,
  type RuntimeConfig,
  type ScoreComponent,
  type Tier,
} from "./types";
import { smoothedRating, topTags } from "./rating";

export const ADAPTIVE_COMPANY_ID = "demo-company";

export interface AdaptiveAnalysisResult {
  analyses: AdaptiveModeAnalysis[];
  recommendations: AdaptivePolicyRecommendation[];
}

const DEFAULT_SETTINGS: AdaptivePolicySettings = {
  enabled: false,
  mode: "recommendation_only",
  minFeedbackCount: 20,
  minUniqueTechnicians: 3,
  maxChangePerUpdate: 0.02,
  cooldownDays: 14,
  minConfidence: 0.75,
  // Customer feedback/ratings must never affect which technician the agent
  // picks (src/agents/scoring.ts hard-zeroes this weight regardless of what
  // a proposal sets it to) — keep the cap at 0 so recommendations and the
  // policy shown to coordinators stay honest about that.
  maxCustomerSatisfactionWeight: 0,
};

type FeedbackJob = { feedback: JobFeedback; job: Job };

/** Pure aggregation entry point used by unit tests and the server analyzer. */
export function analyzeAdaptivePolicy(
  feedback: JobFeedback[],
  jobs: Job[],
  config: RuntimeConfig,
  now = new Date(),
): AdaptiveAnalysisResult {
  const settings = { ...DEFAULT_SETTINGS, ...config.adaptivePolicy };
  const byJob = new Map(jobs.map((job) => [job.job_id, job]));
  const valid: FeedbackJob[] = feedback.flatMap((f) => {
    const job = byJob.get(f.job_id);
    if (!job || job.status !== "completed" || !job.assigned_technician_id || job.assigned_technician_id !== f.technician_id) return [];
    return [{ feedback: f, job }];
  });
  const moderation = classifySuspicious(valid);
  const analyses = (Object.keys(config.dispatchPolicy) as Tier[]).map((tier) => {
    const rows = valid.filter((row) => row.job.tier === tier);
    const excluded = rows.filter((row) => row.feedback.excluded_from_adaptation || moderation.excluded.has(row.feedback.feedback_id));
    const candidate = rows.filter((row) => !excluded.includes(row));
    const balanced = capTechnicianContribution(candidate, excluded, moderation.reasons);
    const metrics = buildMetrics(tier, config.policyVersion, balanced.included, balanced.excluded, moderation.reasons);
    const recommendation = buildRecommendation(tier, config.dispatchPolicy[tier], metrics, config, settings, now);
    return { ...metrics, recommendation };
  });
  return {
    analyses,
    recommendations: analyses.flatMap((analysis) => analysis.recommendation ? [analysis.recommendation] : []),
  };
}

/** Load current DB state, mark suspicious rows, and persist new recommendations. */
export async function analyzeAndStoreAdaptivePolicy(): Promise<AdaptiveAnalysisResult> {
  const [config, jobs, feedback, history, existing] = await Promise.all([
    repo.getConfig(),
    repo.listJobs(),
    repo.listFeedback(),
    repo.listAdaptiveHistory(),
    repo.listAdaptiveRecommendations(),
  ]);
  const result = analyzeAdaptivePolicy(feedback, jobs, config);
  const validJobIds = new Set(jobs.filter((job) => job.status === "completed" && job.assigned_technician_id).map((job) => job.job_id));
  const moderation = classifySuspicious(
    feedback.flatMap((f) => {
      const job = jobs.find((candidate) => candidate.job_id === f.job_id);
      return job && validJobIds.has(job.job_id) && job.assigned_technician_id === f.technician_id ? [{ feedback: f, job }] : [];
    }),
  );
  await Promise.all(
    feedback
      .filter((f) => moderation.reasons.has(f.feedback_id) && !f.flagged)
      .map((f) => repo.updateFeedbackModeration(f.feedback_id, {
        flagged: true,
        excluded_from_adaptation: true,
        flag_reason: moderation.reasons.get(f.feedback_id) ?? "Suspicious feedback pattern",
      })),
  );
  const cutoff = Date.now() - config.adaptivePolicy.cooldownDays * 86_400_000;
  const stored: AdaptivePolicyRecommendation[] = [];
  for (const recommendation of result.recommendations) {
    const recentlyChanged = history.some((change) => change.tier === recommendation.tier && new Date(change.created_at).getTime() >= cutoff);
    const pending = existing.some((item) => item.tier === recommendation.tier && item.status === "pending");
    if (recentlyChanged || pending) continue;
    await repo.insertAdaptiveRecommendation(recommendation);
    stored.push(recommendation);
  }
  return {
    analyses: result.analyses.map((analysis) => ({
      ...analysis,
      recommendation: stored.find((recommendation) => recommendation.tier === analysis.tier) ?? null,
    })),
    recommendations: stored,
  };
}

export async function approveAdaptiveRecommendation(id: string, approvedBy: string): Promise<AdaptivePolicyRecommendation> {
  const recommendation = await repo.getAdaptiveRecommendation(id);
  if (!recommendation) throw new Error("Adaptive recommendation not found.");
  if (recommendation.status !== "pending") throw new Error(`Recommendation is already ${recommendation.status}.`);
  const updated = await repo.updateAdaptiveRecommendation(id, {
    status: "approved",
    approved_at: new Date().toISOString(),
    applied_by: approvedBy,
  });
  if (!updated) throw new Error("Recommendation could not be approved.");
  return updated;
}

export async function rejectAdaptiveRecommendation(id: string, rejectedBy: string): Promise<AdaptivePolicyRecommendation> {
  const recommendation = await repo.getAdaptiveRecommendation(id);
  if (!recommendation) throw new Error("Adaptive recommendation not found.");
  if (recommendation.status !== "pending") throw new Error(`Recommendation is already ${recommendation.status}.`);
  const updated = await repo.updateAdaptiveRecommendation(id, {
    status: "rejected",
    approved_at: new Date().toISOString(),
    applied_by: rejectedBy,
  });
  if (!updated) throw new Error("Recommendation could not be rejected.");
  return updated;
}

export async function applyAdaptiveRecommendation(
  id: string,
  appliedBy: string,
  automatic = false,
): Promise<AdaptivePolicyRecommendation> {
  const recommendation = await repo.getAdaptiveRecommendation(id);
  if (!recommendation) throw new Error("Adaptive recommendation not found.");
  const config = await repo.getConfig();
  if (!automatic && recommendation.status !== "approved") throw new Error("A coordinator must approve this recommendation before applying it.");
  if (automatic && (!config.adaptivePolicy.enabled || config.adaptivePolicy.mode !== "automatic")) {
    throw new Error("Automatic adaptive policy is not enabled.");
  }
  if (!validateAdaptivePolicyProposal(config.dispatchPolicy[recommendation.tier], recommendation.proposed_policy, config.adaptivePolicy)) {
    throw new Error("Recommendation failed policy safety validation.");
  }
  if (!policyVersionMatches(config.policyVersion, recommendation.previous_policy_version)) {
    throw new Error("Policy version changed since this recommendation was generated. Re-analyze before applying it.");
  }
  const nextPolicy = { ...config.dispatchPolicy, [recommendation.tier]: recommendation.proposed_policy };
  const nextVersion = bumpPolicyVersion(config.policyVersion);
  const applied = await repo.updateConfigForPolicyVersion(
    { dispatchPolicy: nextPolicy },
    config.policyVersion,
    nextVersion,
  );
  if (!applied) throw new Error("Policy changed concurrently. Re-analyze before applying this recommendation.");
  await repo.insertAdaptiveHistory({
    change_id: `aph_${Date.now().toString(36)}_${recommendation.tier}`,
    recommendation_id: recommendation.recommendation_id,
    company_id: recommendation.company_id,
    tier: recommendation.tier,
    before_policy: config.dispatchPolicy[recommendation.tier],
    after_policy: recommendation.proposed_policy,
    reason: recommendation.explanation,
    supporting_metrics: recommendation.supporting_metrics,
    feedback_ids: recommendation.included_feedback_ids,
    approved_by: appliedBy,
    change_mode: automatic ? "automatic" : "manual",
    created_at: new Date().toISOString(),
    rollback_of_change_id: null,
  });
  const updated = await repo.updateAdaptiveRecommendation(id, {
    status: "applied",
    applied_at: new Date().toISOString(),
    applied_by: appliedBy,
    new_policy_version: nextVersion,
  });
  if (!updated) throw new Error("Policy applied but recommendation status could not be updated.");
  return updated;
}

export async function rollbackAdaptiveRecommendation(id: string, rolledBackBy: string): Promise<AdaptivePolicyRecommendation> {
  const recommendation = await repo.getAdaptiveRecommendation(id);
  if (!recommendation) throw new Error("Adaptive recommendation not found.");
  if (recommendation.status !== "applied") throw new Error("Only an applied recommendation can be rolled back.");
  const history = (await repo.listAdaptiveHistory()).find((item) => item.recommendation_id === id && item.change_mode !== "rollback");
  if (!history) throw new Error("No applied policy history exists for this recommendation.");
  const config = await repo.getConfig();
  if (!policyVersionMatches(config.policyVersion, recommendation.new_policy_version)) throw new Error("Policy has changed since this recommendation was applied. Rollback was refused.");
  const nextVersion = bumpPolicyVersion(config.policyVersion);
  const nextPolicy = restorePolicyTier(config.dispatchPolicy, recommendation.tier, history.before_policy);
  const restored = await repo.updateConfigForPolicyVersion({ dispatchPolicy: nextPolicy }, config.policyVersion, nextVersion);
  if (!restored) throw new Error("Policy changed concurrently. Rollback was refused.");
  await repo.insertAdaptiveHistory({
    change_id: `aph_rb_${Date.now().toString(36)}_${recommendation.tier}`,
    recommendation_id: id,
    company_id: recommendation.company_id,
    tier: recommendation.tier,
    before_policy: config.dispatchPolicy[recommendation.tier],
    after_policy: history.before_policy,
    reason: `Rollback of recommendation ${id}`,
    supporting_metrics: recommendation.supporting_metrics,
    feedback_ids: recommendation.included_feedback_ids,
    approved_by: rolledBackBy,
    change_mode: "rollback",
    created_at: new Date().toISOString(),
    rollback_of_change_id: history.change_id,
  });
  const updated = await repo.updateAdaptiveRecommendation(id, {
    status: "rolled_back",
    applied_at: new Date().toISOString(),
    applied_by: rolledBackBy,
    new_policy_version: nextVersion,
  });
  if (!updated) throw new Error("Policy rolled back but recommendation status could not be updated.");
  return updated;
}

function bumpPolicyVersion(current: string): string {
  const match = /^policy-v(\d+)$/.exec(current);
  return `policy-v${match ? Number(match[1]) + 1 : Date.now()}`;
}

export function policyVersionMatches(current: string, expected: string | null): boolean {
  return !!expected && current === expected;
}

export function restorePolicyTier(
  current: DispatchPolicy,
  tier: Tier,
  previous: Record<ScoreComponent, number>,
): DispatchPolicy {
  return { ...current, [tier]: { ...previous } };
}

function buildMetrics(
  tier: Tier,
  policyVersion: string,
  includedRows: FeedbackJob[],
  excludedRows: FeedbackJob[],
  reasons: Map<string, string>,
): Omit<AdaptiveModeAnalysis, "recommendation"> {
  const ratings = includedRows.map((row) => row.feedback.rating);
  const count = ratings.length;
  const averageRating = count ? ratings.reduce((sum, rating) => sum + rating, 0) / count : null;
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as Record<1 | 2 | 3 | 4 | 5, number>;
  const positiveCounts: Partial<Record<(typeof FEEDBACK_POSITIVE_TAGS)[number], number>> = {};
  const improvementCounts: Partial<Record<(typeof FEEDBACK_IMPROVEMENT_TAGS)[number], number>> = {};
  const componentTotals: Partial<Record<ScoreComponent, number>> = {};
  const componentCounts: Partial<Record<ScoreComponent, number>> = {};
  let rescheduled = 0;
  for (const row of includedRows) {
    distribution[row.feedback.rating as 1 | 2 | 3 | 4 | 5] += 1;
    for (const tag of row.feedback.positive_tags) positiveCounts[tag] = (positiveCounts[tag] ?? 0) + 1;
    for (const tag of row.feedback.improvement_tags) improvementCounts[tag] = (improvementCounts[tag] ?? 0) + 1;
    if (row.job.reschedule_history.length > 0) rescheduled += 1;
    const score = row.job.score_breakdown;
    if (score) {
      const values: Partial<Record<ScoreComponent, number>> = {
        travel: score.travel,
        skillFit: score.skill_fit,
        availability: score.availability,
        slaHeadroom: score.sla_headroom,
        loadBalance: score.load_balance,
        customerSatisfaction: score.customer_satisfaction,
      };
      for (const component of SCORE_COMPONENTS) {
        const value = values[component];
        if (typeof value === "number") {
          componentTotals[component] = (componentTotals[component] ?? 0) + value;
          componentCounts[component] = (componentCounts[component] ?? 0) + 1;
        }
      }
    }
  }
  const techIds = new Set(includedRows.map((row) => row.feedback.technician_id));
  const summaryRows = includedRows.map((row) => row.feedback);
  const ordered = [...summaryRows].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const trend = ordered.length >= 6
    ? (() => {
        const recent = ordered.slice(0, Math.min(5, ordered.length));
        const older = ordered.slice(5);
        if (!older.length) return null;
        const delta = recent.reduce((s, r) => s + r.rating, 0) / recent.length - older.reduce((s, r) => s + r.rating, 0) / older.length;
        return delta >= 0.3 ? "up" : delta <= -0.3 ? "down" : "flat";
      })()
    : null;
  const confidence = confidenceScore(count, techIds.size, includedRows);
  return {
    tier,
    policyVersion,
    sampleCount: count,
    uniqueTechnicianCount: techIds.size,
    averageRating,
    smoothedRating: smoothedRating(averageRating, count),
    trend,
    distribution,
    positiveTags: topTags(positiveCounts, FEEDBACK_POSITIVE_TAGS),
    improvementTags: topTags(improvementCounts, FEEDBACK_IMPROVEMENT_TAGS),
    rescheduleFrequency: count ? rescheduled / count : null,
    // Arrival timestamps are not recorded in the current schema.
    lateArrivalFrequency: null,
    averageScoreComponents: Object.fromEntries(
      SCORE_COMPONENTS.flatMap((component) => componentCounts[component] ? [[component, (componentTotals[component] ?? 0) / componentCounts[component]]] : []),
    ) as Partial<Record<ScoreComponent, number>>,
    includedFeedbackIds: includedRows.map((row) => row.feedback.feedback_id),
    excludedFeedbackIds: excludedRows.map((row) => row.feedback.feedback_id),
    suspiciousReasons: [...new Set(excludedRows.flatMap((row) => {
      const reason = reasons.get(row.feedback.feedback_id);
      return reason ? [reason] : [];
    }))],
    confidence,
  };
}

function buildRecommendation(
  tier: Tier,
  current: Record<ScoreComponent, number>,
  metrics: Omit<AdaptiveModeAnalysis, "recommendation">,
  config: RuntimeConfig,
  settings: AdaptivePolicySettings,
  now: Date,
): AdaptivePolicyRecommendation | null {
  const limitations = [
    "Observed correlation is not proof of causation; technician mix, geography, and job complexity may confound the signal.",
    "Free-text comments are excluded; only validated ratings and fixed tags are used.",
  ];
  if (metrics.sampleCount < settings.minFeedbackCount || metrics.uniqueTechnicianCount < settings.minUniqueTechnicians) return null;
  if (metrics.confidence < settings.minConfidence) return null;
  const improvement = new Map(metrics.improvementTags.map((item) => [item.tag, item.count / metrics.sampleCount]));
  const changes: AdaptivePolicyChange[] = [];
  if ((improvement.get("late_arrival") ?? 0) >= 0.25) {
    changes.push({ component: "travel", oldWeight: current.travel, newWeight: current.travel + settings.maxChangePerUpdate, delta: settings.maxChangePerUpdate, reason: "Late-arrival feedback is frequent across this delivery mode; increasing travel fit may reduce route slack risk." });
    changes.push({ component: "availability", oldWeight: current.availability, newWeight: current.availability + settings.maxChangePerUpdate / 2, delta: settings.maxChangePerUpdate / 2, reason: "Late-arrival feedback also suggests protecting technician availability headroom." });
  } else if ((improvement.get("repair_quality") ?? 0) >= 0.25) {
    changes.push({ component: "skillFit", oldWeight: current.skillFit, newWeight: current.skillFit + settings.maxChangePerUpdate, delta: settings.maxChangePerUpdate, reason: "Repair-quality feedback appears across multiple technicians in this delivery mode; increasing skill fit may improve matching." });
  } else if ((metrics.smoothedRating < 3.8) && (metrics.averageScoreComponents.loadBalance ?? 0) < 0.55) {
    changes.push({ component: "loadBalance", oldWeight: current.loadBalance, newWeight: current.loadBalance + settings.maxChangePerUpdate, delta: settings.maxChangePerUpdate, reason: "Lower satisfaction coincides with weaker load-balance scores; spreading work may reduce overloaded schedules." });
  }
  if (!changes.length) return null;
  const proposed = adjustAndNormalize(current, changes, settings);
  if (!validateAdaptivePolicyProposal(current, proposed, settings)) return null;
  const safeChanges = SCORE_COMPONENTS.flatMap((component) => {
    const delta = (proposed[component] ?? 0) - (current[component] ?? 0);
    return Math.abs(delta) >= 0.001
      ? [{ component, oldWeight: current[component], newWeight: proposed[component], delta, reason: changes.find((change) => change.component === component)?.reason ?? "Normalization preserves the policy sum." }]
      : [];
  });
  if (!safeChanges.length || safeChanges.some((change) => Math.abs(change.delta) > settings.maxChangePerUpdate + 0.001)) return null;
  return {
    recommendation_id: `apr_${now.getTime().toString(36)}_${tier}`,
    company_id: ADAPTIVE_COMPANY_ID,
    tier,
    current_policy: current,
    proposed_policy: proposed,
    changes: safeChanges,
    supporting_metrics: metrics as unknown as Record<string, unknown>,
    sample_count: metrics.sampleCount,
    unique_technician_count: metrics.uniqueTechnicianCount,
    confidence: metrics.confidence,
    explanation: safeChanges.map((change) => change.reason).join(" "),
    limitations,
    included_feedback_ids: metrics.includedFeedbackIds,
    excluded_feedback_ids: metrics.excludedFeedbackIds,
    status: "pending",
    created_at: now.toISOString(),
    approved_at: null,
    applied_at: null,
    applied_by: null,
    previous_policy_version: config.policyVersion,
    new_policy_version: null,
    source: "rule",
  };
}

export function adjustAndNormalize(
  current: Record<ScoreComponent, number>,
  changes: AdaptivePolicyChange[],
  settings: AdaptivePolicySettings,
): Record<ScoreComponent, number> {
  const raw = { ...current };
  for (const change of changes) raw[change.component] = (raw[change.component] ?? 0) + Math.max(-settings.maxChangePerUpdate, Math.min(settings.maxChangePerUpdate, change.delta));
  raw.customerSatisfaction = Math.min(raw.customerSatisfaction ?? 0, settings.maxCustomerSatisfactionWeight);
  const sum = SCORE_COMPONENTS.reduce((total, component) => total + Math.max(0, raw[component] ?? 0), 0) || 1;
  const normalized = {} as Record<ScoreComponent, number>;
  for (const component of SCORE_COMPONENTS) normalized[component] = Math.round((Math.max(0, raw[component] ?? 0) / sum) * 1000) / 1000;
  const correction = Math.round((1 - SCORE_COMPONENTS.reduce((sum, component) => sum + normalized[component], 0)) * 1000) / 1000;
  const correctionTarget = SCORE_COMPONENTS.reduce((best, component) => normalized[component] > normalized[best] ? component : best, SCORE_COMPONENTS[0]);
  normalized[correctionTarget] = Math.max(0, Math.round((normalized[correctionTarget] + correction) * 1000) / 1000);
  return normalized;
}

/** Re-check stored proposals at the apply boundary. This protects the apply
 * path even if a row was edited manually or an advisor is added later. */
export function validateAdaptivePolicyProposal(
  current: Record<ScoreComponent, number>,
  proposed: Record<string, unknown>,
  settings: AdaptivePolicySettings,
): boolean {
  if (Object.keys(proposed).some((key) => !SCORE_COMPONENTS.includes(key as ScoreComponent))) return false;
  if (SCORE_COMPONENTS.some((component) => typeof proposed[component] !== "number" || !Number.isFinite(proposed[component] as number) || (proposed[component] as number) < 0)) return false;
  const sum = SCORE_COMPONENTS.reduce((total, component) => total + Number(proposed[component]), 0);
  if (Math.abs(sum - 1) > 0.002) return false;
  if (Number(proposed.customerSatisfaction) > settings.maxCustomerSatisfactionWeight + 0.001) return false;
  return SCORE_COMPONENTS.every((component) => Math.abs(Number(proposed[component]) - Number(current[component])) <= settings.maxChangePerUpdate + 0.001);
}

function confidenceScore(count: number, technicians: number, rows: FeedbackJob[]): number {
  const countConfidence = Math.min(1, count / 40);
  const technicianConfidence = Math.min(1, technicians / 5);
  const timestamps = rows.map((row) => new Date(row.feedback.created_at).getTime());
  const timeSpanDays = timestamps.length > 1
    ? Math.max(1, (Math.max(...timestamps) - Math.min(...timestamps)) / 86_400_000)
    : 0;
  const timeConfidence = Math.min(1, timeSpanDays / 14);
  return Math.round((countConfidence * 0.5 + technicianConfidence * 0.35 + timeConfidence * 0.15) * 1000) / 1000;
}

function classifySuspicious(rows: FeedbackJob[]): { excluded: Set<string>; reasons: Map<string, string> } {
  const excluded = new Set<string>();
  const reasons = new Map<string, string>();
  const mark = (row: FeedbackJob, reason: string) => {
    excluded.add(row.feedback.feedback_id);
    reasons.set(row.feedback.feedback_id, reason);
  };
  const byComment = groupBy(rows.filter((row) => row.feedback.comment), (row) => normalizeComment(row.feedback.comment!));
  for (const group of byComment.values()) if (group.length >= 3) group.forEach((row) => mark(row, "Repeated near-identical comments were excluded as a coordinated pattern."));
  const byTags = groupBy(rows, (row) => `${[...row.feedback.positive_tags].sort().join(",")}|${[...row.feedback.improvement_tags].sort().join(",")}`);
  for (const group of byTags.values()) if (group.length >= 5) group.slice(1).forEach((row) => mark(row, "Repeated tag combinations were excluded as a possible coordinated pattern."));
  const bySource = groupBy(rows.filter((row) => row.feedback.source_hash), (row) => row.feedback.source_hash!);
  for (const group of bySource.values()) if (group.length >= 5) group.forEach((row) => mark(row, "A single privacy-preserving source fingerprint contributed an unusual burst."));
  return { excluded, reasons };
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const group = groups.get(k) ?? [];
    group.push(row);
    groups.set(k, group);
  }
  return groups;
}

/** Company-wide policy must not be moved by one technician's customers. Keep
 * at most 40% of usable evidence from any one technician and retain the
 * excluded ids for auditability. This is a best-effort control until the app
 * has authenticated customer identities and stronger anti-Sybil signals. */
function capTechnicianContribution(
  included: FeedbackJob[],
  alreadyExcluded: FeedbackJob[],
  reasons: Map<string, string>,
): { included: FeedbackJob[]; excluded: FeedbackJob[] } {
  if (included.length < 3) return { included, excluded: alreadyExcluded };
  const maxPerTechnician = Math.max(1, Math.floor(included.length * 0.4));
  const byTechnician = groupBy(included, (row) => row.feedback.technician_id);
  const kept: FeedbackJob[] = [];
  const excluded = [...alreadyExcluded];
  for (const rows of byTechnician.values()) {
    const sorted = [...rows].sort((a, b) => b.feedback.created_at.localeCompare(a.feedback.created_at));
    kept.push(...sorted.slice(0, maxPerTechnician));
    for (const row of sorted.slice(maxPerTechnician)) {
      excluded.push(row);
      reasons.set(row.feedback.feedback_id, "Evidence was excluded because one technician would otherwise dominate this company-wide aggregate.");
    }
  }
  return { included: kept, excluded };
}

function normalizeComment(comment: string): string {
  return comment.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 200);
}
