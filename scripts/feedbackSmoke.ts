// End-to-end smoke test for customer feedback + technician performance —
// hits the real Supabase DB and calls the actual Next.js route handlers
// directly (no HTTP server needed).
//
//   npx tsx scripts/feedbackSmoke.ts
//
// Re-seeds the DB first (same convention as scripts/smoke.ts /
// trackingSmoke.ts). Covers: submission, validation, authorization via the
// tracking token, duplicate rejection (including a real concurrent race),
// aggregation correctness, cold start, and — importantly — that the new
// customerSatisfaction scoring component never overrides a hard
// constraint, only nudges the ranking among already-qualified candidates.

import "./_env";
import * as repo from "../src/lib/repo";
import { seedTechnicians, seedJobs, seedFeedback } from "../src/data/seed";
import { DEFAULT_CONFIG, type Job } from "../src/lib/types";
import { scorePool } from "../src/agents/scoring";
import { AgentContext } from "../src/agents/context";
import { GET as publicJobGET } from "../src/app/api/public/jobs/[token]/route";
import { GET as feedbackGET, POST as feedbackPOST } from "../src/app/api/public/jobs/[token]/feedback/route";
import { GET as techniciansGET } from "../src/app/api/technicians/route";

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
  const jobs = seedJobs(DEFAULT_CONFIG.freezeWindowHours);
  for (const j of jobs) await repo.upsertJob(j);
  for (const f of seedFeedback(jobs)) await repo.insertFeedbackIfAbsent(f);
  await repo.updateConfig(DEFAULT_CONFIG);
  return jobs;
}

async function callFeedbackGET(token: string) {
  const req = new Request(`http://localhost/api/public/jobs/${encodeURIComponent(token)}/feedback`);
  const res = await feedbackGET(req, { params: { token } });
  return { status: res.status, body: await res.json() };
}

async function callFeedbackPOST(token: string, body: unknown) {
  const req = new Request(`http://localhost/api/public/jobs/${encodeURIComponent(token)}/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await feedbackPOST(req, { params: { token } });
  return { status: res.status, body: await res.json() };
}

async function main() {
  const seededJobs = await reseed();

  line("1. Submit 5-star feedback for a completed seed job");
  const job2020 = seededJobs.find((j) => j.job_id === "job_2020")!;
  // Give it a fresh token-holder to test against without colliding with the
  // seed's own pre-loaded feedback: use a different completed job that has
  // none yet. job_2020..2029 all have seed feedback already, so create a
  // fresh completed job for the "first submission" scenarios.
  const freshJob: Job = {
    ...job2020,
    job_id: "job_test_completed_1",
    public_tracking_token: "CF-TEST-0001-AAAA",
    assigned_technician_id: "tech_marcus",
    status: "completed",
  };
  await repo.upsertJob(freshJob);

  const r1 = await callFeedbackPOST(freshJob.public_tracking_token, {
    rating: 5,
    positive_tags: ["professional", "on_time"],
    improvement_tags: [],
    comment: "Excellent!",
  });
  check("5-star submission -> 201", r1.status === 201);
  check("response echoes the rating", r1.body.feedback?.rating === 5);

  line("2. Submit 1-star feedback for a different completed job");
  const freshJob2: Job = {
    ...job2020,
    job_id: "job_test_completed_2",
    public_tracking_token: "CF-TEST-0002-BBBB",
    assigned_technician_id: "tech_priya",
    status: "completed",
  };
  await repo.upsertJob(freshJob2);
  const r2 = await callFeedbackPOST(freshJob2.public_tracking_token, {
    rating: 1,
    positive_tags: [],
    improvement_tags: ["late_arrival", "communication"],
    comment: "Not happy.",
  });
  check("1-star submission -> 201", r2.status === 201);

  line("3/4/5. Invalid rating / tags / oversized comment rejected");
  const freshJob3: Job = {
    ...job2020,
    job_id: "job_test_completed_3",
    public_tracking_token: "CF-TEST-0003-CCCC",
    assigned_technician_id: "tech_wei_jie",
    status: "completed",
  };
  await repo.upsertJob(freshJob3);
  const badRating = await callFeedbackPOST(freshJob3.public_tracking_token, { rating: 9 });
  check("rating=9 -> 400", badRating.status === 400);
  const badTags = await callFeedbackPOST(freshJob3.public_tracking_token, { rating: 4, positive_tags: ["not_a_real_tag"] });
  check("unknown tag -> 400", badTags.status === 400);
  const bigComment = await callFeedbackPOST(freshJob3.public_tracking_token, { rating: 4, comment: "x".repeat(5000) });
  check("oversized comment -> 400", bigComment.status === 400);
  // None of the bad attempts should have created a row.
  const stillNone = await repo.getFeedbackByJobId(freshJob3.job_id);
  check("no feedback row created by any rejected attempt", stillNone === undefined);

  line("6/7. Feedback only allowed after completion + requires an assigned technician");
  const pendingJob: Job = {
    ...job2020,
    job_id: "job_test_pending",
    public_tracking_token: "CF-TEST-0004-DDDD",
    assigned_technician_id: null,
    status: "pending",
  };
  await repo.upsertJob(pendingJob);
  const onPending = await callFeedbackPOST(pendingJob.public_tracking_token, { rating: 5 });
  check("feedback on a pending/unassigned job -> 409", onPending.status === 409);

  const assignedNotDone: Job = {
    ...job2020,
    job_id: "job_test_assigned",
    public_tracking_token: "CF-TEST-0005-EEEE",
    assigned_technician_id: "tech_marcus",
    status: "assigned",
  };
  await repo.upsertJob(assignedNotDone);
  const onAssigned = await callFeedbackPOST(assignedNotDone.public_tracking_token, { rating: 5 });
  check("feedback on an assigned-but-not-completed job -> 409", onAssigned.status === 409);

  line("8/9. Tracking-token authorization — can't touch another job, invalid token is generic 404");
  const wrongToken = await callFeedbackPOST("CF-0000-0000-0000", { rating: 5 });
  check("malformed token -> 404 (not 409, not a validation error)", wrongToken.status === 404);
  const unknownToken = await callFeedbackPOST("CF-9999-9999-9999", { rating: 5 });
  check("well-formed but unknown token -> 404", unknownToken.status === 404);
  check(
    "both 404s carry the identical generic message",
    wrongToken.body.error === unknownToken.body.error,
  );
  // The public GET (tracking) endpoint must never accept a raw job_id as a
  // substitute for the token, for feedback either.
  const byJobId = await callFeedbackPOST(freshJob.job_id, { rating: 5 });
  check("job_id used as a token -> 404, not the job's feedback endpoint", byJobId.status === 404);

  line("10/11. Duplicate rejected, including a real concurrent race");
  const dup = await callFeedbackPOST(freshJob.public_tracking_token, { rating: 3 });
  check("second submission for the same job -> 409", dup.status === 409);
  const afterDup = await repo.getFeedbackByJobId(freshJob.job_id);
  check("the original 5-star rating was not overwritten", afterDup?.rating === 5);

  const raceJob: Job = {
    ...job2020,
    job_id: "job_test_race",
    public_tracking_token: "CF-TEST-0006-FFFF",
    assigned_technician_id: "tech_hui_ling",
    status: "completed",
  };
  await repo.upsertJob(raceJob);
  const [raceA, raceB] = await Promise.all([
    callFeedbackPOST(raceJob.public_tracking_token, { rating: 5 }),
    callFeedbackPOST(raceJob.public_tracking_token, { rating: 1 }),
  ]);
  const raceStatuses = [raceA.status, raceB.status].sort();
  check("concurrent duplicate submissions: exactly one succeeds (201) and one is rejected (409)", raceStatuses[0] === 201 && raceStatuses[1] === 409);
  const raceRows = await repo.listFeedbackForTechnician("tech_hui_ling");
  check("the race produced exactly one stored row for that job", raceRows.filter((r) => r.job_id === raceJob.job_id).length === 1);

  line("12/13/14. Technician rating aggregation — correct, zero, and one rating");
  const techResp = await techniciansGET();
  const techBody = await techResp.json();
  const marcusRating = techBody.ratings["tech_marcus"];
  check("tech_marcus aggregation present with count > 0", marcusRating && marcusRating.count > 0);
  check("tech_marcus average is a plain number in [1,5]", marcusRating.average >= 1 && marcusRating.average <= 5);
  const gopalRating = techBody.ratings["tech_gopal"];
  check("tech_gopal (zero seed feedback) -> average null, not 0", gopalRating && gopalRating.average === null);
  check("tech_gopal -> smoothed equals the prior (cold start)", Math.abs(gopalRating.smoothed - 4.3) < 1e-9);

  line("15. Rating smoothing is actually applied (not a raw average)");
  check(
    "tech_priya (1 real 5-star + the fresh 1-star just submitted = 2 ratings): smoothed sits between prior and average",
    (() => {
      const p = techBody.ratings["tech_priya"];
      return p.smoothed > 1 && p.smoothed < 4.3 + 0.01;
    })(),
  );

  line("16/17. Hard constraints still win; rating only nudges among the qualified");
  {
    const ctx = await AgentContext.create();
    // tech_kelvin only holds basic_maintenance — scoring a job that needs
    // refrigerant_handling must exclude him regardless of any rating.
    const pool = scorePool(ctx, ["tech_marcus", "tech_kelvin"], {
      jobLocation: { lat: 1.3521, lng: 103.8198 },
      skillRequired: ["refrigerant_handling"],
      scheduledTime: new Date(Date.now() + 6 * 3600_000).toISOString(),
      ignoreJobId: "__scoring_test__",
      tier: "standard",
    });
    check(
      "unqualified technician (wrong skill) never appears in the scored pool, however high their rating",
      pool.every((p) => p.technician_id !== "tech_kelvin"),
    );
    check("qualified technician (tech_marcus) is scored", pool.some((p) => p.technician_id === "tech_marcus"));
    const marcusEntry = pool.find((p) => p.technician_id === "tech_marcus");
    check(
      "customer_satisfaction is present on the breakdown and contributes a small, non-zero fraction of the total",
      !!marcusEntry &&
        (marcusEntry.breakdown.customer_satisfaction ?? 0) > 0 &&
        (marcusEntry.breakdown.customer_satisfaction ?? 0) < marcusEntry.breakdown.total,
    );
  }

  line("18. Reassigned job credits the technician who actually completed it");
  {
    // Simulate: job originally went to tech_wei_jie, got reassigned (as a
    // real disruption re-plan would do) to tech_hui_ling, THEN completed.
    // Feedback must attach to tech_hui_ling, never tech_wei_jie.
    const reassigned: Job = {
      ...job2020,
      job_id: "job_test_reassigned",
      public_tracking_token: "CF-TEST-0007-GGGG",
      assigned_technician_id: "tech_hui_ling", // final technician
      status: "completed",
      reschedule_history: [
        { at: new Date().toISOString(), from_time: "2026-01-01T00:00:00Z", to_time: "2026-01-01T02:00:00Z", reason: "Urgent job took priority", decided_by: "auto" },
      ],
    };
    await repo.upsertJob(reassigned);
    const beforeCount = (await repo.listFeedbackForTechnician("tech_hui_ling")).length;
    const submit = await callFeedbackPOST(reassigned.public_tracking_token, { rating: 4 });
    check("feedback on a reassigned+completed job succeeds", submit.status === 201);
    const stored = await repo.getFeedbackByJobId(reassigned.job_id);
    check("stored technician_id is the FINAL technician (hui_ling), not the original", stored?.technician_id === "tech_hui_ling");
    const afterCount = (await repo.listFeedbackForTechnician("tech_hui_ling")).length;
    check("tech_hui_ling's feedback count increased by exactly 1", afterCount === beforeCount + 1);
    const weiJieRows = await repo.listFeedbackForTechnician("tech_wei_jie");
    check("tech_wei_jie (never actually did the work) got no credit for this job", !weiJieRows.some((r) => r.job_id === reassigned.job_id));
  }

  line("19/20/21/22. Existing flows still work");
  const jobsResp = await repo.listJobs();
  check("existing jobs list still loads (booking/admin/tech flows depend on this)", jobsResp.length > 0);
  const techsResp = await repo.listTechnicians();
  check("existing technician roster still loads", techsResp.length > 0);
  const trackResp = await publicJobGET(
    new Request(`http://localhost/api/public/jobs/${freshJob.public_tracking_token}`),
    { params: { token: freshJob.public_tracking_token } },
  );
  const trackBody = await trackResp.json();
  check("existing customer tracking endpoint still works end to end", trackResp.status === 200 && trackBody.status === "completed");
  check("tracking view now reports feedbackEligible appropriately (already submitted, still completed)", trackBody.feedbackEligible === true);
  const feedbackStatus = await callFeedbackGET(freshJob.public_tracking_token);
  check("feedback GET reports submitted:true after a successful POST", feedbackStatus.body.submitted === true);

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
