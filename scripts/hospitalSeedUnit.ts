// Real booking + approval agents and repository, with in-memory Supabase HTTP.
// No live DB writes, external messages, or LLM calls.
import assert from "node:assert/strict";
import { mock } from "node:test";
import { buildHospitalDataset, HOSPITAL_BOOKING } from "../src/data/hospitalSeed";
import { configToRow, jobToRow, technicianToRow } from "../src/lib/mappers";
import { addHours, findTimeClash, hoursBetween, isWithinWorkingHours, sgDayKey } from "../src/lib/time";
import { estimateDriveMinutes } from "../src/lib/geo";
import { estimatedJobMinutes, type Job, type Technician } from "../src/lib/types";

function validateSchedule(jobs: Job[], technicians: Technician[]) {
  for (const tech of technicians) {
    const scheduled = jobs.filter((j) => j.status !== "pending" && j.assigned_technician_id === tech.technician_id)
      .sort((a, b) => a.scheduled_time.localeCompare(b.scheduled_time));
    let previous: Job | undefined;
    for (const j of scheduled) {
      assert.ok(j.skill_required.every((s) => tech.skill_tags.includes(s)));
      const end = addHours(j.scheduled_time, estimatedJobMinutes(j.skill_required) / 60);
      assert.ok(isWithinWorkingHours(tech.working_hours, j.scheduled_time));
      assert.ok(isWithinWorkingHours(tech.working_hours, end));
      if (previous && sgDayKey(previous.scheduled_time) === sgDayKey(j.scheduled_time)) {
        const depart = addHours(previous.scheduled_time, estimatedJobMinutes(previous.skill_required) / 60);
        const gap = hoursBetween(depart, j.scheduled_time) * 60;
        const drive = estimateDriveMinutes(previous.location, j.location, depart);
        assert.ok(gap >= drive, `${j.job_id} on ${tech.technician_id}: ${gap} minutes after ${previous.job_id}, needs ${drive} minutes travel`);
      }
      previous = j;
    }
  }
}

async function main() {
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-27T01:00:00.000Z") });
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://hospital-test.invalid";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service";
  process.env.LLM_MODE = "stub";
  const data = buildHospitalDataset();
  assert.equal(data.technicians.length, 9);
  assert.equal(data.jobs.length, 27);
  assert.equal(data.jobs.filter((j) => j.status === "in_progress").length, 9);
  validateSchedule(data.jobs, data.technicians);
  for (const t of data.technicians) {
    assert.ok(findTimeClash(data.jobs, t.technician_id, addHours(data.anchorISO, 4), "incoming"));
  }
  const keys: Record<string, string> = {
    jobs: "job_id", technicians: "technician_id", runtime_config: "id",
    agent_decision_log: "log_id", approval_requests: "approval_id", notifications: "notification_id", job_feedback: "feedback_id",
  };
  let tables: Record<string, Record<string, unknown>[]> = {
    jobs: data.jobs.map(jobToRow), technicians: data.technicians.map(technicianToRow),
    runtime_config: [configToRow(data.config)], agent_decision_log: [], approval_requests: [], notifications: [], job_feedback: [],
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.hostname, "hospital-test.invalid", "Never contact a live service");
    const table = url.pathname.split("/").pop()!;
    assert.ok(table in tables, `Unexpected table ${table}`);
    const matches = (row: Record<string, unknown>) => [...url.searchParams].every(([key, value]) => !value.startsWith("eq.") || String(row[key]) === value.slice(3));
    const method = init?.method ?? "GET";
    if (method === "POST") {
      const body = JSON.parse(String(init?.body));
      for (const row of Array.isArray(body) ? body : [body]) {
        const index = tables[table].findIndex((r) => r[keys[table]] === row[keys[table]]);
        if (index < 0) tables[table].push(row);
        else tables[table][index] = { ...tables[table][index], ...row };
      }
      return new Response(null, { status: 201 });
    }
    if (method === "PATCH") {
      const patch = JSON.parse(String(init?.body));
      tables[table] = tables[table].map((row) => matches(row) ? { ...row, ...patch } : row);
      return new Response(null, { status: 204 });
    }
    assert.equal(method, "GET");
    const rows = tables[table].filter(matches);
    const start = Number(url.searchParams.get("offset") ?? 0);
    const page = rows.slice(start, start + Number(url.searchParams.get("limit") ?? 1000));
    return Response.json(page, { headers: { "content-range": `${start}-${start + page.length - 1}/${rows.length}` } });
  };
  const { runBookingPipeline } = await import("../src/agents/orchestrator");
  const { resolveApproval } = await import("../src/agents/approval");
  const repo = await import("../src/lib/repo");
  const baseline = structuredClone(tables);
  const result = await runBookingPipeline(HOSPITAL_BOOKING);
  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.job.status, "pending");
  assert.equal(result.approval?.kind, "standard");
  assert.ok(result.approval?.options.length);
  assert.equal(result.notificationsSent, 0);
  assert.deepEqual(tables.jobs.filter((j) => j.job_id !== result.job.job_id), baseline.jobs, "Existing appointments untouched while waiting");
  assert.deepEqual(tables.technicians, baseline.technicians, "No dispatch while waiting");
  for (const agent of ["JobIntakeAgent", "PricingEngine", "CapacityAgent", "AssignmentAgent", "DisruptionAgent", "Orchestrator"]) {
    assert.ok(tables.agent_decision_log.some((row) => row.agent_name === agent), `Flow map has ${agent}`);
  }
  const assignment = tables.agent_decision_log.find((row) => row.agent_name === "AssignmentAgent")!;
  assert.equal((assignment.output_summary as { eligible_count: number }).eligible_count, 0);
  console.log("PASS: all 9 busy; real booking traverses intake, pricing, capacity, assignment, disruption and HITL; no early schedule changes");
  const pending = structuredClone(tables);
  for (const option of result.approval!.options) {
    tables = structuredClone(pending);
    const approved = await resolveApproval({ approvalId: result.approval!.approval_id, decision: "approve", chosenOptionId: option.option_id, coordinatorName: "Demo Coordinator" });
    assert.equal(approved.ok, true, approved.message);
    assert.equal((await repo.getJob(result.job.job_id))?.status, "assigned");
    validateSchedule(await repo.listJobs(), await repo.listTechnicians());
    for (const move of option.moves) {
      const moved = await repo.getJob(move.job_id);
      assert.equal(moved?.scheduled_time, move.to_time);
      assert.equal(moved?.reschedule_history.at(-1)?.decided_by, "Demo Coordinator");
    }
    assert.equal((await repo.getApproval(result.approval!.approval_id))?.resolved_by, "Demo Coordinator");
    assert.ok(tables.notifications.length >= 4);
    assert.ok(tables.agent_decision_log.some((row) => row.agent_name === "NotificationAgent"));
  }
  tables = structuredClone(pending);
  assert.equal((await resolveApproval({ approvalId: result.approval!.approval_id, decision: "reject", coordinatorName: "Demo Coordinator" })).ok, true);
  assert.deepEqual(tables.jobs.filter((j) => j.job_id !== result.job.job_id), baseline.jobs);
  assert.equal((await repo.getJob(result.job.job_id))?.status, "pending");
  assert.equal(tables.notifications.length, 0);
  console.log(`PASS: all ${result.approval!.options.length} approval options dispatch safely with named audit and notifications; rejection preserves the schedule`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => mock.timers.reset());
