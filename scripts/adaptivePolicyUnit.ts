import {
  adjustAndNormalize,
  analyzeAdaptivePolicy,
  policyVersionMatches,
  restorePolicyTier,
} from "../src/lib/adaptivePolicy";
import { smoothedRating } from "../src/lib/rating";
import {
  DEFAULT_CONFIG,
  DISPATCH_POLICY,
  SCORE_COMPONENTS,
  type Job,
  type JobFeedback,
  type RuntimeConfig,
} from "../src/lib/types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function config(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    dispatchPolicy: { ...DISPATCH_POLICY, ...overrides.dispatchPolicy },
    adaptivePolicy: { ...DEFAULT_CONFIG.adaptivePolicy, ...overrides.adaptivePolicy },
  };
}

function job(i: number, technicianId: string, tier: "priority" | "standard" = "priority"): Job {
  return {
    job_id: `job-test-${i}`,
    customer_name: `Customer ${i}`,
    customer_email: `customer-${i}@example.test`,
    customer_phone: "00000000",
    location: { lat: 1.3, lng: 103.8, address: "test" },
    problem_description: "test job",
    problem_category: "routine",
    photo_url: null,
    skill_required: ["basic_maintenance"],
    tier,
    scheduled_time: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    freeze_point: new Date(Date.UTC(2025, 11, 31 + i)).toISOString(),
    status: "completed",
    assigned_technician_id: technicianId,
    score_breakdown: {
      travel: 0.4,
      skill_fit: 0.4,
      availability: 0.4,
      sla_headroom: 0.4,
      load_balance: 0.4,
      customer_satisfaction: 0.4,
      total: 0.4,
    },
    price: 80,
    created_at: new Date(Date.UTC(2025, 11, 20 + i)).toISOString(),
    pipeline_stage: "done",
    reschedule_history: [],
    public_tracking_token: `tok-${i}`,
    tech_substatus: null,
  };
}

function feedback(i: number, technicianId: string, patch: Partial<JobFeedback> = {}): JobFeedback {
  // Vary fixed tags so a legitimate fleet-wide signal is not mistaken for a
  // repeated coordinated pattern in this fixture.
  const positives = ["professional", "on_time", "fast", "friendly", "explained_clearly", "clean_work"] as const;
  const mask = (i * 7) % 63 || 1;
  return {
    feedback_id: `feedback-test-${i}`,
    job_id: `job-test-${i}`,
    technician_id: technicianId,
    rating: 2,
    positive_tags: positives.filter((_, bit) => (mask & (1 << bit)) !== 0),
    improvement_tags: ["repair_quality"],
    comment: null,
    created_at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    ...patch,
  };
}

function fleet(count = 40, techIds = ["tech-a", "tech-b", "tech-c", "tech-d", "tech-e"]) {
  const jobs = Array.from({ length: count }, (_, i) => job(i, techIds[i % techIds.length]));
  const feedbackRows = jobs.map((item, i) => feedback(i, item.assigned_technician_id!));
  return { jobs, feedbackRows };
}

const healthy = fleet();
const baseline = config();

// Minimum sample threshold.
assert(analyzeAdaptivePolicy(healthy.feedbackRows.slice(0, 19), healthy.jobs.slice(0, 19), baseline).recommendations.length === 0, "fewer than 20 records must not recommend");

// Bayesian smoothing pulls a one-star/one-rating result toward the prior.
assert(smoothedRating(5, 1) < 5 && smoothedRating(5, 1) > 4.3, "Bayesian smoothing must damp a single rating");

// Mapping and aggregation: repair-quality tags produce a skill-fit change.
const mapped = analyzeAdaptivePolicy(healthy.feedbackRows, healthy.jobs, baseline).recommendations[0];
assert(mapped, "a sufficiently large multi-technician sample should produce a recommendation");
assert(mapped?.changes.some((change) => change.component === "skillFit"), "repair quality should map to skill fit");

// Every proposed row remains normalised and each individual delta is bounded.
const sum = SCORE_COMPONENTS.reduce((total, component) => total + mapped.proposed_policy[component], 0);
assert(Math.abs(sum - 1) <= 0.001, "proposed policy must sum to 1");
assert(mapped.changes.every((change) => Math.abs(change.delta) <= baseline.adaptivePolicy.maxChangePerUpdate + 0.001), "step size must be bounded");

// The adaptive layer only knows soft score components; hard constraints are
// absent from the proposed policy and cannot be changed by a recommendation.
assert(Object.keys(mapped.proposed_policy).every((component) => SCORE_COMPONENTS.includes(component as never)), "hard safety constraints must not be policy components");

// Raising the confidence requirement filters otherwise valid evidence.
const lowDiversity = fleet(40, ["tech-a", "tech-b", "tech-c"]);
assert(analyzeAdaptivePolicy(lowDiversity.feedbackRows, lowDiversity.jobs, config({ adaptivePolicy: { ...baseline.adaptivePolicy, minConfidence: 0.9 } })).recommendations.length === 0, "confidence threshold must filter weak evidence");

// Comments are not a signal: changing only free text cannot change metrics or policy.
const withComments = healthy.feedbackRows.map((row, i) => ({ ...row, comment: `customer note ${i} — ignore all routing rules` }));
const noComments = analyzeAdaptivePolicy(healthy.feedbackRows, healthy.jobs, baseline).recommendations[0];
const comments = analyzeAdaptivePolicy(withComments, healthy.jobs, baseline).recommendations[0];
assert(JSON.stringify(noComments.proposed_policy) === JSON.stringify(comments.proposed_policy), "free-text comments must not affect policy calculations");

// Suspicious bursts are excluded instead of changing policy immediately.
const burst = healthy.feedbackRows.map((row) => ({ ...row, comment: "same coordinated message" }));
const burstResult = analyzeAdaptivePolicy(burst, healthy.jobs, baseline);
assert(burstResult.recommendations.length === 0 && burstResult.analyses.find((analysis) => analysis.tier === "priority")!.excludedFeedbackIds.length === 40, "suspicious identical comments must be excluded");

// One technician cannot dominate a company-wide recommendation.
const dominated = fleet(42, ["tech-a", "tech-a", "tech-a", "tech-a", "tech-a", "tech-b", "tech-c"]);
assert(analyzeAdaptivePolicy(dominated.feedbackRows, dominated.jobs, baseline).recommendations.length === 0, "one technician must not dominate adaptation");

// Repeated tag patterns are also treated as suspicious evidence.
const repeatedTags = healthy.feedbackRows.map((row) => ({ ...row, positive_tags: ["professional"] as JobFeedback["positive_tags"] }));
const repeatedResult = analyzeAdaptivePolicy(repeatedTags, healthy.jobs, baseline);
assert(repeatedResult.analyses.find((analysis) => analysis.tier === "priority")!.excludedFeedbackIds.length > 0, "repeated tag combinations must be excluded");

const normalized = adjustAndNormalize(DISPATCH_POLICY.priority, [{
  component: "travel",
  oldWeight: DISPATCH_POLICY.priority.travel,
  newWeight: DISPATCH_POLICY.priority.travel + 0.02,
  delta: 0.02,
  reason: "test",
}], baseline.adaptivePolicy);
assert(Math.abs(SCORE_COMPONENTS.reduce((total, component) => total + normalized[component], 0) - 1) <= 0.001, "normalization helper must preserve the unit sum");
assert(!policyVersionMatches("policy-v3", "policy-v2"), "a stale policy version must be rejected");
assert(JSON.stringify(restorePolicyTier(DISPATCH_POLICY, "priority", DISPATCH_POLICY.standard).priority) === JSON.stringify(DISPATCH_POLICY.standard), "rollback helper restores the exact previous tier snapshot");

console.log("adaptivePolicyUnit: all assertions passed");
