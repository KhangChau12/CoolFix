// End-to-end smoke test for the customer tracking feature — hits the real
// Supabase DB (like scripts/smoke.ts) and calls the actual Next.js route
// handlers directly (no HTTP server needed; they're plain async functions).
//
//   npx tsx scripts/trackingSmoke.ts
//
// REQUIRES migration supabase/migrations/0005_public_tracking.sql to have
// been run first (adds jobs.public_tracking_token / jobs.tech_substatus) —
// see README.md "Local setup". Re-seeds the DB before running, same as
// scripts/smoke.ts.

import "./_env";
import * as repo from "../src/lib/repo";
import { runBookingPipeline } from "../src/agents/orchestrator";
import { resolveApproval } from "../src/agents/approval";
import { seedTechnicians, seedJobs } from "../src/data/seed";
import { DEFAULT_CONFIG } from "../src/lib/types";
import { SG_LANDMARKS } from "../src/lib/geo";
import { GET as publicGET } from "../src/app/api/public/jobs/[token]/route";
import { PATCH as jobPATCH } from "../src/app/api/jobs/[id]/route";

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

async function reseed() {
  await repo.wipeAll();
  for (const t of seedTechnicians()) await repo.upsertTechnician(t);
  for (const j of seedJobs(DEFAULT_CONFIG.freezeWindowHours)) await repo.upsertJob(j);
  await repo.updateConfig(DEFAULT_CONFIG);
}

async function callPublic(token: string) {
  const req = new Request(`http://localhost/api/public/jobs/${encodeURIComponent(token)}`);
  const res = await publicGET(req, { params: { token } });
  const body = await res.json();
  return { status: res.status, body };
}

async function callTechStatus(jobId: string, action: "en_route" | "arrived" | "completed") {
  const req = new Request(`http://localhost/api/jobs/${jobId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action }),
  });
  const res = await jobPATCH(req, { params: { id: jobId } });
  return { status: res.status, body: await res.json() };
}

async function main() {
  await reseed();

  line("1/2. Booking generates a unique tracking token");
  const r1 = await runBookingPipeline({
    customer_name: "Track Test One",
    customer_email: "track1@test.sg",
    customer_phone: "+65 9000 1001",
    address: "Blk 1 Clementi Ave 3",
    location: SG_LANDMARKS.clementi,
    problem_category: "routine",
    problem_description: "Routine cleaning, filter wash.",
    photo_url: null,
    tier: "standard",
    preferred_date: null,
  });
  const token1 = r1.job.public_tracking_token;
  check("booking result includes a well-formed tracking token", /^CF(-[A-Z0-9]{4}){3}$/.test(token1));

  const r2 = await runBookingPipeline({
    customer_name: "Track Test Two",
    customer_email: "track2@test.sg",
    customer_phone: "+65 9000 1002",
    address: "Blk 2 Clementi Ave 3",
    location: SG_LANDMARKS.clementi,
    problem_category: "routine",
    problem_description: "Routine cleaning, filter wash.",
    photo_url: null,
    tier: "standard",
    preferred_date: null,
  });
  const token2 = r2.job.public_tracking_token;
  check("two bookings get different tokens", token1 !== token2);

  line("3. GET /api/public/jobs/:token returns the right job");
  const got1 = await callPublic(token1);
  check("200 for a valid token", got1.status === 200);
  check("returns the tracking token back", got1.body.trackingToken === token1);
  check("service summary matches this booking", got1.body.service.summary.includes("Routine cleaning"));
  check("does NOT return the other booking's data", !JSON.stringify(got1.body).includes("Track Test Two"));

  line("4. Invalid / unknown tokens get a safe, generic 404");
  const badFormat = await callPublic("not-a-real-token");
  const wellFormedUnknown = await callPublic("CF-9999-9999-9999");
  check("malformed token -> 404", badFormat.status === 404);
  check("well-formed-but-unknown token -> 404", wellFormedUnknown.status === 404);
  check(
    "both return the exact same generic message (no enumeration signal)",
    badFormat.body.error === wellFormedUnknown.body.error,
  );

  line("5. A raw job_id must NOT work as a substitute for the token");
  const byJobId = await callPublic(r1.job.job_id);
  check("GET /api/public/jobs/<job_id> -> 404, not the job", byJobId.status === 404);
  const directLookup = await repo.getJobByTrackingToken(r1.job.job_id);
  check("repo.getJobByTrackingToken(job_id) finds nothing", directLookup === undefined);

  line("6. Public view never exposes internal fields");
  const dump = JSON.stringify(got1.body);
  check("no customer_email", !dump.includes("track1@test.sg"));
  check("no customer_phone", !dump.includes("+65 9000 1001"));
  check("no job_id", !dump.includes(r1.job.job_id));
  check("no score_breakdown key", !("score_breakdown" in got1.body));
  check("no candidates key", !("candidates" in got1.body));
  if (r1.job.assigned_technician_id) {
    const tech = await repo.getTechnician(r1.job.assigned_technician_id);
    check("no technician phone", !!tech && !dump.includes(tech.phone));
    check("no technician_id", !dump.includes(r1.job.assigned_technician_id));
  }

  line("7. Technician status transitions reflect in the public view");
  if (r1.job.assigned_technician_id) {
    await callTechStatus(r1.job.job_id, "en_route");
    const enRoute = await callPublic(token1);
    check("status -> en_route after 'en_route' action", enRoute.body.status === "en_route");
    check("statusLabel is customer-friendly", enRoute.body.statusLabel === "Technician is on the way");

    await callTechStatus(r1.job.job_id, "arrived");
    const arrived = await callPublic(token1);
    check("status -> arrived after 'arrived' action", arrived.body.status === "arrived");

    await callTechStatus(r1.job.job_id, "completed");
    const completed = await callPublic(token1);
    check("status -> completed after 'completed' action", completed.body.status === "completed");
    check("eta is null once completed", completed.body.eta === null);
  } else {
    console.log("  (skipped — booking 1 had no eligible technician in this seed)");
  }

  line("8. HITL-pending booking is still trackable");
  const rHitl = await runBookingPipeline({
    customer_name: "Track Test Urgent",
    customer_email: "trackurgent@test.sg",
    customer_phone: "+65 9000 1003",
    address: "Blk 505 Woodlands Dr 14",
    location: SG_LANDMARKS.woodlands,
    problem_category: "not_cooling",
    problem_description: "Refrigerant leak, need someone today ASAP.",
    photo_url: null,
    tier: "urgent",
    preferred_date: null,
  });
  const hitlToken = rHitl.job.public_tracking_token;
  const hitlView = await callPublic(hitlToken);
  check("HITL-pending booking is trackable (200, not an error)", hitlView.status === 200);
  check(
    "status communicates review, not a raw pipeline stage",
    ["reviewing_change", "reviewing_request", "assigned", "en_route"].includes(hitlView.body.status),
  );
  check("does not expose replan_options", !("replan_options" in hitlView.body));

  if (rHitl.approval) {
    const res = await resolveApproval({
      approvalId: rHitl.approval.approval_id,
      decision: "approve",
      coordinatorName: "Smoke Test Coordinator",
    });
    check("approval resolved ok", res.ok);
    const afterApproval = await callPublic(hitlToken);
    check(
      "after approval, status moves to assigned/en_route (not stuck reviewing)",
      ["assigned", "en_route", "arrived", "completed"].includes(afterApproval.body.status),
    );
  } else {
    console.log("  (no approval was raised for this run — assignment found a free slot)");
  }

  line("RESULT");
  if (failures === 0) {
    console.log("All checks passed.");
    process.exit(0);
  } else {
    console.log(`${failures} check(s) FAILED.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
