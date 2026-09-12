// Pure-logic tests for the customer tracking feature — no DB, no HTTP
// server. Run with: npx tsx scripts/trackingUnit.ts
//
// Covers the parts of the acceptance criteria that don't require a live
// Supabase connection: token generation/format/uniqueness, the
// customer-safe view builder (status mapping + "must never leak X"), and
// the "Track My Service" input normalizer. The DB-touching scenarios
// (booking → token persisted, GET by token, invalid token 404, HITL /
// en_route / arrived / completed states end-to-end) live in
// scripts/trackingSmoke.ts, which needs migration 0005 applied first.

import "./_env";
import { generateTrackingToken } from "../src/lib/trackingToken";
import {
  isValidTrackingTokenFormat,
  normalizeTrackingTokenInput,
} from "../src/lib/trackingTokenFormat";
import { toPublicJobView } from "../src/lib/publicTracking";
import type { Job, Technician } from "../src/lib/types";

let failures = 0;
function check(name: string, cond: unknown) {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}`);
  }
}

function line(s: string) {
  console.log("\n" + "─".repeat(70) + "\n" + s + "\n" + "─".repeat(70));
}

const BASE_JOB: Job = {
  job_id: "job_test1",
  customer_name: "Alex Tan",
  customer_email: "alex@example.sg",
  customer_phone: "+65 9000 0000",
  location: { lat: 1.29, lng: 103.85, address: "1 Raffles Place" },
  problem_description: "Aircon not cooling, strange noise from the unit.",
  problem_category: "not_cooling",
  photo_url: null,
  skill_required: ["refrigerant_handling"],
  tier: "priority",
  scheduled_time: new Date(Date.now() + 3 * 3600_000).toISOString(),
  freeze_point: new Date(Date.now() + 1 * 3600_000).toISOString(),
  status: "assigned",
  assigned_technician_id: "tech_1",
  score_breakdown: {
    travel: 0.8,
    skill_fit: 0.9,
    availability: 0.7,
    sla_headroom: 0.6,
    load_balance: 0.5,
    total: 0.874,
  },
  price: 220,
  created_at: new Date().toISOString(),
  pipeline_stage: "assigned",
  reschedule_history: [],
  public_tracking_token: "CF-7KQ9-X2PM-4LR3",
  tech_substatus: null,
};

const BASE_TECH: Technician = {
  technician_id: "tech_1",
  name: "Marcus Lim",
  photo_url: "https://example.com/marcus.jpg",
  skill_tags: ["refrigerant_handling", "electrical_work"],
  experience_level: "senior",
  location: { lat: 1.3, lng: 103.86 },
  working_hours: { start: "09:00", end: "18:00" },
  current_workload: 3,
  phone: "+65 8123 4567",
};

line("1. Token generation — format, uniqueness, entropy");
const tokens = new Set<string>();
for (let i = 0; i < 5000; i++) tokens.add(generateTrackingToken());
check("5000 generated tokens are all unique", tokens.size === 5000);
check("generated token matches its own format validator", isValidTrackingTokenFormat(generateTrackingToken()));
check("token is never derived from a job_id-looking string", !/JOB/i.test(generateTrackingToken()));

line("2. Token format validation — rejects garbage without hitting the DB");
check("rejects a raw job_id", !isValidTrackingTokenFormat("job_abc123"));
check("rejects lowercase", !isValidTrackingTokenFormat("cf-7kq9-x2pm-4lr3"));
check("rejects wrong group count", !isValidTrackingTokenFormat("CF-7KQ9-X2PM"));
check("rejects ambiguous characters (0/O/1/I/L not in alphabet)", !isValidTrackingTokenFormat("CF-0000-1111-OOLL"));
check("rejects empty string", !isValidTrackingTokenFormat(""));
check("rejects SQL-ish input", !isValidTrackingTokenFormat("' OR 1=1 --"));
check("accepts a real generated token", isValidTrackingTokenFormat(generateTrackingToken()));

line("3. Track-My-Service input normalization");
check(
  "lowercase + no dashes normalizes to canonical form",
  normalizeTrackingTokenInput("cf7kq9x2pm4lr3") === "CF-7KQ9-X2PM-4LR3",
);
check(
  "extra spaces are stripped",
  normalizeTrackingTokenInput("  CF-7KQ9-X2PM-4LR3  ") === "CF-7KQ9-X2PM-4LR3",
);

line("4. Public job view — never leaks internal fields");
const view = toPublicJobView(BASE_JOB, BASE_TECH);
const json = JSON.stringify(view);
check("does not include technician phone", !json.includes(BASE_TECH.phone));
check("does not include technician_id", !json.includes(BASE_TECH.technician_id));
check("does not include job_id", !json.includes(BASE_JOB.job_id));
check("does not include customer_email", !json.includes(BASE_JOB.customer_email));
check("does not include customer_phone", !json.includes(BASE_JOB.customer_phone));
check("does not include raw score_breakdown numbers", !("score_breakdown" in view) && !json.includes("0.874"));
check("does not include a candidates list", !("candidates" in view));
check("does not include replan_options", !("replan_options" in view));
check("technician name IS included (customer-safe)", json.includes("Marcus Lim"));
check("has a plain-language statusLabel, not a raw pipeline_stage/status enum value", view.statusLabel === "Technician assigned");
check("explanation is deterministic prose, not a score", !!view.explanation && !view.explanation.includes("0."));

line("5. Customer-facing status mapping");
function statusFor(patch: Partial<Job>): string {
  return toPublicJobView({ ...BASE_JOB, ...patch }, null).status;
}
check("intake -> request_received", statusFor({ status: "pending", pipeline_stage: "intake", assigned_technician_id: null }) === "request_received");
check("pricing -> preparing_service", statusFor({ status: "pending", pipeline_stage: "pricing", assigned_technician_id: null }) === "preparing_service");
check("capacity_check -> finding_technician", statusFor({ status: "pending", pipeline_stage: "capacity_check", assigned_technician_id: null }) === "finding_technician");
check("scoring -> selecting_technician", statusFor({ status: "pending", pipeline_stage: "scoring", assigned_technician_id: null }) === "selecting_technician");
check("assigned -> assigned", statusFor({ status: "assigned", pipeline_stage: "assigned" }) === "assigned");
check("in_progress + no substatus -> en_route", statusFor({ status: "in_progress", tech_substatus: null }) === "en_route");
check("in_progress + arrived -> arrived", statusFor({ status: "in_progress", tech_substatus: "arrived" }) === "arrived");
check("completed -> completed", statusFor({ status: "completed" }) === "completed");
check("awaiting_approval (HITL, no assignment yet) -> reviewing_request", statusFor({ status: "pending", pipeline_stage: "awaiting_approval", assigned_technician_id: null }) === "reviewing_request");
check(
  "awaiting_approval after a reschedule -> reviewing_change",
  statusFor({
    status: "pending",
    pipeline_stage: "awaiting_approval",
    reschedule_history: [{ at: new Date().toISOString(), from_time: "x", to_time: "y", reason: "Urgent job took priority", decided_by: "auto" }],
  }) === "reviewing_change",
);

line("6. Disruption messaging uses the same safe `reason` text, not raw agent output");
const disruptedView = toPublicJobView(
  {
    ...BASE_JOB,
    reschedule_history: [
      { at: new Date().toISOString(), from_time: "2026-01-01T00:00:00Z", to_time: "2026-01-01T02:00:00Z", reason: "Urgent job took priority", decided_by: "auto" },
    ],
  },
  BASE_TECH,
);
check("disruption block present after a reschedule", !!disruptedView.disruption);
check("disruption detail references the sanitized reason", !!disruptedView.disruption && disruptedView.disruption.detail.includes("Urgent job took priority"));
check("no disruption block when nothing was rescheduled", toPublicJobView(BASE_JOB, BASE_TECH).disruption === null);

line("7. Technician / location hidden until actually assigned");
const unassigned = toPublicJobView({ ...BASE_JOB, status: "pending", assigned_technician_id: null, pipeline_stage: "scoring" }, null);
check("no technician block before assignment", unassigned.technician === null);
check("no technician location before assignment", unassigned.technicianLocation === null);
check("no eta before assignment", unassigned.eta === null);

line("RESULT");
if (failures === 0) {
  console.log("All checks passed.");
  process.exit(0);
} else {
  console.log(`${failures} check(s) FAILED.`);
  process.exit(1);
}
