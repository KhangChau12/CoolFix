// End-to-end smoke test for the technician-unavailable disruption trigger —
// hits the real Supabase DB and calls the real orchestration/approval
// functions directly (no HTTP server needed).
//
//   npx tsx scripts/technicianUnavailableSmoke.ts
//
// Re-seeds the DB first (same convention as scripts/feedbackSmoke.ts /
// trackingSmoke.ts). This is the demo's centerpiece disruption scenario —
// see src/agents/disruption.ts's runTechnicianUnavailableReplan and
// src/agents/orchestrator.ts's runTechnicianUnavailable. Covers both halves
// of the demo pair seeded specifically for this (src/data/seed.ts,
// "Technician-unavailable disruption demo"):
//
//   job_2012 (Daniel, not frozen) -> Marcus unavailable? no, Daniel
//     unavailable -> a same-slot swap exists -> low risk -> AUTO-COMMIT.
//   job_2001 (Marcus, frozen)     -> Marcus unavailable -> inside its
//     freeze window -> ALWAYS a human, however clean the swap ->
//     Emergency Override HITL, approve-and-commit correctly applies it.
//
// Also covers: an unknown technician id, a technician with nothing left to
// re-plan today, and that hard constraints (certification) are never
// bypassed by this path either.

import "./_env";
import * as repo from "../src/lib/repo";
import { seedTechnicians, seedJobs, seedFeedback } from "../src/data/seed";
import { DEFAULT_CONFIG } from "../src/lib/types";
import { runTechnicianUnavailable } from "../src/agents/orchestrator";
import { resolveApproval } from "../src/agents/approval";

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

async function main() {
  await reseed();

  line("1. Low-risk case: Daniel unavailable — job_2012 has a clean same-slot swap");
  {
    const r = await runTechnicianUnavailable("tech_daniel", "Vehicle breakdown");
    check("exactly one affected job (job_2012)", r.affectedJobs.length === 1 && r.affectedJobs[0].jobId === "job_2012");
    const outcome = r.affectedJobs[0];
    check("auto-reassigned, not sent for approval", outcome?.outcome === "auto_reassigned");
    check("kept the exact same appointment time", outcome?.sameSlot === true);
    check("reassigned to a real, different technician", !!outcome?.newTechnicianId && outcome.newTechnicianId !== "tech_daniel");
    check("at least one decision-log row was written", r.decisionLogIds.length > 0);
    check("the technician + customer were notified (reschedule)", r.notificationsSent >= 2);

    const job = await repo.getJob("job_2012");
    check("job_2012 is actually committed onto the new technician in the DB", job?.assigned_technician_id === outcome?.newTechnicianId);
    check("job_2012's status reflects a real commit (assigned/frozen, not pending)", job?.status === "assigned" || job?.status === "frozen");

    const newTech = await repo.listTechnicians().then((ts) => ts.find((t) => t.technician_id === outcome?.newTechnicianId));
    check(
      "the new technician actually holds the required certification (hard constraint was never bypassed)",
      !!newTech && job!.skill_required.every((s) => newTech.skill_tags.includes(s)),
    );
  }

  line("2. High-risk case: Marcus unavailable — job_2001 is frozen, always Emergency Override");
  // Reseed first — section 1 just reassigned job_2012 onto Marcus, which
  // would otherwise give him two affected jobs here instead of one.
  await reseed();
  let overrideApprovalId: string | null = null;
  {
    const r = await runTechnicianUnavailable("tech_marcus", "Called in sick");
    check("exactly one affected job (job_2001)", r.affectedJobs.length === 1 && r.affectedJobs[0].jobId === "job_2001");
    const outcome = r.affectedJobs[0];
    check("sent for approval, not auto-committed", outcome?.outcome === "needs_approval");
    check(
      "kind is emergency_override — a frozen job's technician was touched",
      outcome?.approvalKind === "emergency_override",
    );
    check("an approval id was returned", !!outcome?.approvalId);
    overrideApprovalId = outcome?.approvalId ?? null;

    const approval = overrideApprovalId ? await repo.getApproval(overrideApprovalId) : undefined;
    check("the stored approval really is kind=emergency_override", approval?.kind === "emergency_override");
    check("frozen_jobs_impacted correctly names job_2001", (approval?.frozen_jobs_impacted ?? []).includes("job_2001"));
    check("the approval offers at least one concrete option", (approval?.options.length ?? 0) > 0);

    const job = await repo.getJob("job_2001");
    check("job_2001 stays pending (not committed) while the approval is outstanding", job?.status === "pending");
  }

  line("3. Approving the Emergency Override actually commits the reassignment");
  {
    if (!overrideApprovalId) {
      check("had an approval id to resolve", false);
    } else {
      const before = await repo.getJob("job_2001");
      const approvalBefore = await repo.getApproval(overrideApprovalId);
      const chosenOpt = approvalBefore?.options.find((o) => o.recommended) ?? approvalBefore?.options[0];
      const intendedTechId = chosenOpt?.moves.find((m) => m.job_id === "job_2001")?.technician_id;
      // While pending, the job already HOLDS the recommended candidate (same
      // convention as the booking-conflict HITL path — see
      // runTechnicianUnavailable in orchestrator.ts) — so `before` is
      // expected to already show `intendedTechId`, not still "tech_marcus".
      // The real regression this guards against is approval.ts silently
      // reverting `applyReplan`'s update back to job_2001's ORIGINAL
      // pre-disruption values (Marcus, its original slot) — see the
      // `alreadyHandledByReplan` fix in approval.ts.
      check("intended technician was resolvable from the approval's options", !!intendedTechId);
      check("while pending, the job already holds the recommended candidate", before?.assigned_technician_id === intendedTechId);

      const result = await resolveApproval({
        approvalId: overrideApprovalId,
        decision: "approve",
        coordinatorName: "Test Coordinator",
      });
      check("approval resolved ok", result.ok);

      const after = await repo.getJob("job_2001");
      check("job_2001 is no longer assigned to the unavailable technician", after?.assigned_technician_id !== "tech_marcus");
      check(
        "job_2001 ended up on the technician the approved option actually named (not silently reverted — regression check for the approval.ts staleness fix)",
        after?.assigned_technician_id === intendedTechId,
      );
      check("job_2001's status reflects a real commit", after?.status === "assigned" || after?.status === "frozen");
      check("reschedule_history recorded the change with a coordinator name", (after?.reschedule_history.length ?? 0) > (before?.reschedule_history.length ?? 0));
    }
  }

  line("4. Edge cases");
  await reseed();
  {
    const r = await runTechnicianUnavailable("tech_priya", "Testing a technician with no remaining jobs today, or whatever they have left is fine either way");
    check("running against ANY technician never throws", true);
    check("every returned outcome (if any) is one of the three valid kinds", r.affectedJobs.every((j) => ["auto_reassigned", "needs_approval", "unresolvable"].includes(j.outcome)));
  }
  {
    let threw = false;
    try {
      await runTechnicianUnavailable("tech_does_not_exist", "x");
    } catch {
      threw = true;
    }
    check("an unknown technician id throws instead of silently doing nothing", threw);
  }

  line("RESULT");
  if (failures === 0) {
    console.log("All checks passed.");
  } else {
    console.log(`${failures} check(s) FAILED.`);
    process.exitCode = 1;
  }
}

main();
