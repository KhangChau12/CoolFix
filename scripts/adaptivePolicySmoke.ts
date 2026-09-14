// DB-backed adaptive-policy smoke test. Run with a migrated Supabase database:
//   npx tsx scripts/adaptivePolicySmoke.ts
// It intentionally resets the demo database, matching the existing smoke-test
// convention. It does not use customer comments as an adaptive signal.
import "./_env";
import * as repo from "../src/lib/repo";
import { analyzeAndStoreAdaptivePolicy, approveAdaptiveRecommendation, applyAdaptiveRecommendation, rollbackAdaptiveRecommendation } from "../src/lib/adaptivePolicy";
import { AgentContext } from "../src/agents/context";
import { runBookingPipeline } from "../src/agents/orchestrator";
import { seedTechnicians } from "../src/data/seed";
import { DEFAULT_CONFIG, type Job, type JobFeedback } from "../src/lib/types";

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ok  ${message}`);
}

function makeJob(i: number, technicianId: string, policyVersion: string, snapshot: Job["dispatch_policy_snapshot"]): Job {
  return {
    job_id: `adaptive-smoke-job-${i}`,
    customer_name: `Adaptive Customer ${i}`,
    customer_email: `adaptive-${i}@example.test`,
    customer_phone: "00000000",
    location: { lat: 1.31, lng: 103.82, address: "Smoke test" },
    problem_description: "Completed smoke-test service",
    problem_category: "routine",
    photo_url: null,
    skill_required: ["basic_maintenance"],
    tier: "priority",
    scheduled_time: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
    freeze_point: new Date(Date.UTC(2025, 11, i + 1)).toISOString(),
    status: "completed",
    assigned_technician_id: technicianId,
    score_breakdown: { travel: 0.4, skill_fit: 0.4, availability: 0.4, sla_headroom: 0.4, load_balance: 0.4, customer_satisfaction: 0.4, total: 0.4 },
    price: 80,
    created_at: new Date(Date.UTC(2025, 11, i + 1)).toISOString(),
    pipeline_stage: "done",
    reschedule_history: [],
    public_tracking_token: `adaptive-smoke-token-${i}`,
    tech_substatus: null,
    dispatch_policy_version: policyVersion,
    dispatch_policy_snapshot: snapshot,
  };
}

function makeFeedback(i: number, job: Job): JobFeedback {
  const positive = ["professional", "on_time", "fast", "friendly", "explained_clearly", "clean_work"] as const;
  const mask = (i * 7) % 63 || 1;
  return {
    feedback_id: `adaptive-smoke-feedback-${i}`,
    job_id: job.job_id,
    technician_id: job.assigned_technician_id!,
    rating: 2,
    positive_tags: positive.filter((_, bit) => (mask & (1 << bit)) !== 0),
    improvement_tags: ["repair_quality"],
    comment: `private note ${i}`,
    created_at: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
  };
}

async function main() {
  await repo.wipeAll();
  for (const technician of seedTechnicians()) await repo.upsertTechnician(technician);
  await repo.updateConfig({ ...DEFAULT_CONFIG, adaptivePolicy: { ...DEFAULT_CONFIG.adaptivePolicy, enabled: false, mode: "recommendation_only" } });
  const initial = await repo.getConfig();
  const technicians = ["tech_marcus", "tech_wei_jie", "tech_priya", "tech_daniel", "tech_gopal"];
  const jobs = Array.from({ length: 40 }, (_, i) => makeJob(i, technicians[i % technicians.length], initial.policyVersion, initial.dispatchPolicy));
  for (const job of jobs) await repo.upsertJob(job);
  const feedback = jobs.map((job, i) => makeFeedback(i, job));
  const inserts = await Promise.all(feedback.map((row) => repo.insertFeedbackIfAbsent(row)));
  check(inserts.every((result) => result.ok), "completed jobs and feedback are seeded");

  const analysis = await analyzeAndStoreAdaptivePolicy();
  const recommendation = analysis.recommendations.find((item) => item.tier === "priority");
  check(!!recommendation, "adaptive recommendation is generated and stored");
  check((await repo.listAdaptiveRecommendations()).some((item) => item.recommendation_id === recommendation?.recommendation_id), "recommendation is persisted");

  const approved = await approveAdaptiveRecommendation(recommendation!.recommendation_id, "smoke coordinator");
  check(approved.status === "approved", "coordinator approval is required and recorded");
  const applied = await applyAdaptiveRecommendation(approved.recommendation_id, "smoke coordinator");
  const afterApply = await repo.getConfig();
  check(applied.status === "applied" && afterApply.policyVersion !== initial.policyVersion, "applying changes runtime_config and advances policy version");
  check(afterApply.dispatchPolicy.priority.skillFit === recommendation!.proposed_policy.skillFit, "the proposed soft policy is applied");
  const historicalJobs = await repo.listJobs();
  check(historicalJobs.filter((job) => job.job_id.startsWith("adaptive-smoke-job-")).every((job) => job.dispatch_policy_version === initial.policyVersion), "existing completed jobs retain their old policy version");
  check(historicalJobs.filter((job) => job.job_id.startsWith("adaptive-smoke-job-")).every((job) => JSON.stringify(job.dispatch_policy_snapshot) === JSON.stringify(initial.dispatchPolicy)), "existing completed jobs retain their old policy snapshot");

  const ctx = await AgentContext.create();
  check(ctx.config.policyVersion === afterApply.policyVersion && ctx.config.dispatchPolicy.priority.skillFit === afterApply.dispatchPolicy.priority.skillFit, "the next assignment context loads the new policy snapshot");

  const next = await runBookingPipeline({ customer_name: "Future customer", customer_email: "future@example.test", customer_phone: "00000000", address: "Bishan, Singapore", location: { lat: 1.35, lng: 103.85 }, problem_category: "routine", problem_description: "Routine maintenance", photo_url: null, tier: "priority", preferred_date: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) });
  check(next.job.dispatch_policy_version === afterApply.policyVersion, "a future booking records the newly applied policy version");
  check(JSON.stringify(next.job.dispatch_policy_snapshot) === JSON.stringify(afterApply.dispatchPolicy), "a future booking records the newly applied policy snapshot");

  const rolledBack = await rollbackAdaptiveRecommendation(applied.recommendation_id, "smoke coordinator");
  const afterRollback = await repo.getConfig();
  check(rolledBack.status === "rolled_back", "rollback is recorded");
  check(JSON.stringify(afterRollback.dispatchPolicy.priority) === JSON.stringify(initial.dispatchPolicy.priority), "rollback restores the exact previous tier policy");

  const duplicate = await Promise.all([repo.insertFeedbackIfAbsent(feedback[0]), repo.insertFeedbackIfAbsent(feedback[0])]);
  check(duplicate.filter((result) => !result.ok && result.reason === "duplicate").length >= 1, "duplicate feedback remains rejected by the database constraint");
  console.log("adaptivePolicySmoke: all assertions passed");
}

main().catch((error) => { console.error(error); process.exit(1); });
