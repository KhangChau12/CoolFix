// Exercise approval resolution through the real context/repository with
// mocked Supabase HTTP. Never reads or mutates a live database.
import assert from "node:assert/strict";
import { mock } from "node:test";
import { configToRow } from "../src/lib/mappers";
import { DEFAULT_CONFIG } from "../src/lib/types";

async function main() {
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-24T00:00:00.000Z") });
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://approval-test.invalid";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service";
  const slot = "2026-09-24T02:00:00.000Z";
  const later = "2026-09-24T05:00:00.000Z";
  const job = (id: string, technician: string, status: string) => ({
    job_id: id, customer_name: id, customer_email: `${id}@example.test`,
    customer_phone: "", location: { lat: 1.3, lng: 103.8, address: "test" },
    problem_description: "test", skill_required: ["basic_maintenance"],
    tier: "standard", scheduled_time: slot, freeze_point: slot,
    created_at: slot, status, assigned_technician_id: technician,
    pipeline_stage: status === "pending" ? "awaiting_approval" : "assigned",
    public_tracking_token: `CF-${id}`, reschedule_history: [],
  });
  const jobs = [job("incoming", "tech-a", "pending"), job("existing", "tech-b", "assigned")];
  const technicians = ["tech-a", "tech-b"].map((id) => ({
    technician_id: id, name: id, skill_tags: ["basic_maintenance"],
    experience_level: "senior", location: { lat: 1.3, lng: 103.8 },
    working_hours: { start: "08:00", end: "18:00" }, current_workload: 1,
  }));
  const option = (id: string, target: string, time: string, movedJob = "existing") => ({
    option_id: id, label: id, summary: id, recommended: true,
    moves: [{ job_id: movedJob, customer_name: movedJob, from_time: slot, to_time: time, technician_id: target }],
    trade_offs: { customers_affected: 1, total_added_travel_km: 0, sla_breaches: 0, frozen_jobs_touched: 0 },
  });
  const approval = {
    approval_id: "approval-test", created_at: slot, kind: "standard", job_id: "incoming",
    reason: "test", disruption_log_id: "original-log", status: "pending",
    options: [option("collision", "tech-a", slot), option("incoming-collision", "tech-b", slot, "incoming"), option("clear", "tech-b", later)],
  };
  const writes: { table: string; method: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.hostname, "approval-test.invalid", "Never access a live service in this test");
    const table = url.pathname.split("/").pop()!;
    if (init?.method && init.method !== "GET") {
      writes.push({ table, method: init.method, body: JSON.parse(String(init.body)) });
      return new Response(null, { status: 201 });
    }
    const tables: Record<string, unknown[]> = {
      approval_requests: [approval], jobs, technicians, job_feedback: [],
      runtime_config: [configToRow(DEFAULT_CONFIG)],
    };
    assert.ok(table in tables, `Unexpected read: ${table}`);
    const rows = tables[table];
    return Response.json(rows, { headers: { "content-range": `0-${Math.max(0, rows.length - 1)}/${rows.length}` } });
  };
  const { resolveApproval } = await import("../src/agents/approval");
  for (const chosenOptionId of ["collision", "incoming-collision"]) {
    writes.length = 0;
    const result = await resolveApproval({ approvalId: "approval-test", decision: "approve", chosenOptionId, coordinatorName: "test coordinator" });
    assert.equal(result.ok, false);
    assert.match(result.message, /double-book/);
    assert.equal(writes.length, 1, "A rejected plan must only persist its audit log");
    assert.equal(writes[0].table, "agent_decision_log");
    assert.equal(writes[0].body.outcome, "rejected");
    assert.equal((writes[0].body.output_summary as Record<string, unknown>).result, "rejected_integrity_check");
    assert.equal(approval.status, "pending");
  }
  console.log("ok: invalid existing-job and incoming-job moves log rejection without schedule, workload, approval or notification writes");
  writes.length = 0;
  const accepted = await resolveApproval({ approvalId: "approval-test", decision: "approve", chosenOptionId: "clear", coordinatorName: "test coordinator" });
  assert.equal(accepted.ok, true);
  assert.ok(writes.some((write) => write.table === "jobs" && write.body.job_id === "existing" && write.body.scheduled_time === later));
  assert.ok(writes.some((write) => write.table === "approval_requests" && write.body.status === "approved"));
  assert.ok(writes.some((write) => write.table === "notifications"));
  console.log("ok: a valid approval still commits the move, resolves approval and notifies recipients");
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => mock.timers.reset());
