// Offline checks: no Supabase credentials, LLM calls, or remote mutations.
import assert from "node:assert/strict";
import { buildDemoDataset } from "../src/data/demoSeed";
import { mock } from "node:test";
import { distanceKm, estimateDriveMinutes, isWithinSG } from "../src/lib/geo";
import { addHours, computeFreezePoint, hoursBetween, sgDayKey, isWithinWorkingHours } from "../src/lib/time";
import { isValidTrackingTokenFormat } from "../src/lib/trackingToken";
import { estimatedJobMinutes, TIER_META, type Job } from "../src/lib/types";
import { AgentContext } from "../src/agents/context";
import { applyReplan, incomingJobClashAfterReplan } from "../src/agents/orchestrator";

mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-24T01:00:00.000Z") });
const data = buildDemoDataset();
const clock = data.anchorISO;
assert.equal(data.config.clockMode, "real");
assert.equal(data.config.customTimeISO, null);
assert.equal(clock, "2026-09-24T01:00:00.000Z");
assert.equal(data.technicians.length, 12);
assert.equal(data.jobs.length, 174);
assert.equal(data.approvals.length, 4);
assert.equal(data.feedback.length, 68);
assert.ok(data.decisions.length > 1000, "Dataset exercises paginated reads");

function validateSchedule(jobs: Job[]) {
  // An awaiting-approval candidate carries the proposed technician ID under
  // the existing resolver contract. It is not a committed appointment yet.
  const scheduled = jobs.filter((j) => j.status !== "pending");
  let longLegs = 0;
  for (const tech of data.technicians) {
    const byDay = new Map<string, Job[]>();
    for (const j of scheduled.filter((j) => j.assigned_technician_id === tech.technician_id)) {
      assert.ok(j.skill_required.every((skill) => tech.skill_tags.includes(skill)), `${j.job_id}: certification`);
      assert.ok(isWithinSG(j.location), `${j.job_id}: Singapore bounds`);
      assert.ok(isWithinWorkingHours(tech.working_hours, j.scheduled_time), `${j.job_id}: shift start`);
      const end = addHours(j.scheduled_time, estimatedJobMinutes(j.skill_required) / 60);
      assert.ok(isWithinWorkingHours(tech.working_hours, end), `${j.job_id}: shift end`);
      assert.equal(j.freeze_point, computeFreezePoint(j.scheduled_time, data.config.freezeWindowHours));
      assert.ok(hoursBetween(j.created_at, j.scheduled_time) <= TIER_META[j.tier].slaHours, `${j.job_id}: SLA`);
      const day = sgDayKey(j.scheduled_time);
      byDay.set(day, [...(byDay.get(day) ?? []), j]);
    }
    for (const [day, dayJobs] of byDay) {
      dayJobs.sort((a, b) => a.scheduled_time.localeCompare(b.scheduled_time));
      let previousLocation = tech.location;
      let departure = new Date(`${day}T${tech.working_hours.start}:00+08:00`).toISOString();
      for (const j of dayJobs) {
        const km = distanceKm(previousLocation, j.location);
        if (km >= 8) longLegs++;
        const drive = estimateDriveMinutes(previousLocation, j.location, departure);
        assert.ok(hoursBetween(departure, j.scheduled_time) * 60 >= drive, `${j.job_id}: needs ${drive} minutes from preceding stop, including peak-hour slowdown`);
        previousLocation = j.location;
        departure = addHours(j.scheduled_time, estimatedJobMinutes(j.skill_required) / 60);
      }
    }
  }
  assert.ok(longLegs >= 150, "Long routes remain visually evident across the schedule");
}
validateSchedule(data.jobs);
console.log("PASS: 170 committed jobs satisfy skills, complete shift windows, service durations, travel gaps, freeze points and SLAs");

const jobIds = new Set(data.jobs.map((j) => j.job_id));
const logIds = new Set(data.decisions.map((d) => d.log_id));
assert.equal(jobIds.size, data.jobs.length);
assert.equal(logIds.size, data.decisions.length);
assert.equal(new Set(data.jobs.map((j) => j.public_tracking_token)).size, data.jobs.length);
for (const j of data.jobs) {
  assert.ok(isValidTrackingTokenFormat(j.public_tracking_token));
  assert.ok(j.created_at <= clock, `${j.job_id}: booking exists by the demo clock`);
}
for (const n of data.notifications) assert.ok(jobIds.has(n.job_id));
for (const f of data.feedback) {
  const job = data.jobs.find((j) => j.job_id === f.job_id)!;
  assert.equal(job.status, "completed");
  assert.equal(f.technician_id, job.assigned_technician_id);
  assert.ok(f.created_at <= clock);
}
for (const t of data.technicians) assert.equal(t.current_workload, data.jobs.filter((j) => j.status !== "pending" && j.assigned_technician_id === t.technician_id && sgDayKey(j.scheduled_time) === sgDayKey(clock)).length);
console.log("PASS: identifiers, private tracking tokens, feedback history, references and current-day workloads are consistent");

// Exercise the real replan mutator and resolver's clash check with an in-memory
// context. Override persistence only; the domain functions are unmodified.
function context() {
  const ctx = new AgentContext();
  ctx.jobs = structuredClone(data.jobs);
  ctx.technicians = structuredClone(data.technicians);
  ctx.config = structuredClone(data.config);
  ctx.stageJob = (job: Job) => { ctx.jobs = ctx.jobs.map((j) => j.job_id === job.job_id ? job : j); };
  ctx.stageWorkload = (id: string, delta: number) => {
    const tech = ctx.technicians.find((t) => t.technician_id === id)!;
    tech.current_workload += delta;
  };
  return ctx;
}
for (const approval of data.approvals) {
  assert.ok(jobIds.has(approval.job_id));
  assert.ok(logIds.has(approval.disruption_log_id));
  assert.equal(approval.status, "pending");
  for (const id of approval.frozen_jobs_impacted) assert.equal(data.jobs.find((j) => j.job_id === id)?.status, "frozen");
  for (const option of approval.options) {
    const ctx = context();
    applyReplan(ctx, option.option_id, approval.options, "Demo Unit Coordinator", "Synthetic approval test");
    assert.equal(incomingJobClashAfterReplan(ctx, approval.job_id), null);
    const incoming = ctx.getJob(approval.job_id)!;
    ctx.stageJob({ ...incoming, status: "assigned", pipeline_stage: "assigned" });
    validateSchedule(ctx.jobs);
    for (const move of option.moves) {
      const moved = ctx.getJob(move.job_id)!;
      assert.equal(moved.scheduled_time, move.to_time);
      assert.equal(moved.reschedule_history.at(-1)?.decided_by, "Demo Unit Coordinator");
    }
  }
}
const both = context();
for (const a of data.approvals.filter((a) => a.options.length)) {
  const option = a.options.find((o) => o.recommended)!;
  applyReplan(both, option.option_id, a.options, "Demo Unit Coordinator", "Synthetic approval test");
  assert.equal(incomingJobClashAfterReplan(both, a.job_id), null);
  both.stageJob({ ...both.getJob(a.job_id)!, status: "assigned", pipeline_stage: "assigned" });
}
validateSchedule(both.jobs);
assert.equal(data.approvals.filter((a) => !a.options.length).length, 2);
console.log("PASS: every approval option and both recommended plans together apply without collisions; proposal cases remain coordinator-owned");

const shifted = buildDemoDataset("2027-01-02T08:00:00.000Z");
assert.equal(shifted.anchorISO, "2027-01-02T01:00:00.000Z");
assert.equal(shifted.config.clockMode, "real");
assert.equal(shifted.jobs.length, data.jobs.length);
assert.deepEqual(shifted.jobs.map((j) => [j.job_id, j.status, j.skill_required]), data.jobs.map((j) => [j.job_id, j.status, j.skill_required]));
assert.throws(() => buildDemoDataset("invalid"), /Invalid demo anchor/);
mock.timers.reset();
console.log("PASS: reproducible scenarios support an alternate demo date without changing the fixture");
