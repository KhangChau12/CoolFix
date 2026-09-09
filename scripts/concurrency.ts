// ── Concurrency probe ───────────────────────────────────────────────
// Fires several bookings at the pipeline at once (Promise.all, no await
// between them) and checks the DB is left consistent:
//   - every returned job exists in the DB with the status the result claims
//   - no agent-created double-booking across the final board
//   - no two committed jobs share the exact same (tech, slot)
//   - the frozen job is untouched
// `runBookingPipeline` serializes itself (in-process queue) because one
// AgentContext = one up-front snapshot of the schedule; this probe is the
// regression guard for that. Runs whatever LLM_MODE is set (gateway by
// default). Trimmed to 2 groups — a clean parallel pair and the
// two-urgent-same-slot race that actually exercises the serialization —
// so a gateway run is ~12 LLM calls. The 5-mixed burst is in git history.
// Exits non-zero on any violation. Run it on its own — it wipes and
// re-seeds the shared Supabase project between cases.
//
//   npm run concurrency
import "./_env";
import * as repo from "../src/lib/repo";
import { runBookingPipeline } from "../src/agents/orchestrator";
import { seedTechnicians, seedJobs } from "../src/data/seed";
import { DEFAULT_CONFIG } from "../src/lib/types";
import { SG_LANDMARKS } from "../src/lib/geo";

async function reseed() {
  await repo.wipeAll();
  for (const t of seedTechnicians()) await repo.upsertTechnician(t);
  for (const j of seedJobs(DEFAULT_CONFIG.freezeWindowHours)) await repo.upsertJob(j);
  await repo.updateConfig(DEFAULT_CONFIG);
}

const base = { customer_phone: "+65 9000 0000", photo_url: null, preferred_date: null };
const SEED_IDS = new Set(seedJobs(DEFAULT_CONFIG.freezeWindowHours).map((s) => s.job_id));

let violations = 0;
const bad = (m: string) => {
  violations++;
  console.log(`  ✗ ${m}`);
};

async function run(label: string, bookings: Parameters<typeof runBookingPipeline>[0][]) {
  await reseed();
  console.log(`\n[${label}] firing ${bookings.length} bookings with Promise.all`);
  const results = await Promise.allSettled(bookings.map((b) => runBookingPipeline(b)));

  const committed: { id: string; tech: string; slot: string }[] = [];
  // Jobs that are only staged (awaiting_approval) — overlapping something
  // while a coordinator decides is the expected staged state, not a bug.
  const stagedOnly = new Set<string>();
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "rejected") {
      console.log(`  · booking ${i} REJECTED: ${String(r.reason).slice(0, 120)}`);
      continue;
    }
    const pr = r.value;
    const dbJob = await repo.getJob(pr.job.job_id);
    if (!dbJob) {
      bad(`booking ${i}: result job ${pr.job.job_id} not in DB`);
      continue;
    }
    console.log(`  · booking ${i}: ${pr.status} tech=${pr.job.assigned_technician_id ?? "-"} @ ${dbJob.scheduled_time} db.status=${dbJob.status}`);
    if ((pr.status === "assigned_auto" || pr.status === "assigned_after_replan") && dbJob.assigned_technician_id) {
      committed.push({ id: dbJob.job_id, tech: dbJob.assigned_technician_id, slot: dbJob.scheduled_time });
    } else if (pr.status === "awaiting_approval") {
      stagedOnly.add(pr.job.job_id);
    }
  }

  // exact (tech, slot) collision among committed jobs from this run
  for (let a = 0; a < committed.length; a++) {
    for (let b = a + 1; b < committed.length; b++) {
      if (committed[a].tech === committed[b].tech && committed[a].slot === committed[b].slot) {
        bad(`exact collision: ${committed[a].id} & ${committed[b].id} both ${committed[a].tech} @ ${committed[a].slot}`);
      }
    }
  }

  // full-board agent double-booking check
  const allJobs = await repo.listJobs();
  const byTech = new Map<string, typeof allJobs>();
  for (const j of allJobs) {
    if (!j.assigned_technician_id || j.status === "completed" || j.status === "disrupted") continue;
    const arr = byTech.get(j.assigned_technician_id) ?? [];
    arr.push(j);
    byTech.set(j.assigned_technician_id, arr);
  }
  for (const [techId, jobs] of byTech) {
    jobs.sort((x, y) => x.scheduled_time.localeCompare(y.scheduled_time));
    for (let i = 1; i < jobs.length; i++) {
      const gap = Math.abs(
        (new Date(jobs[i].scheduled_time).getTime() - new Date(jobs[i - 1].scheduled_time).getTime()) / 3_600_000,
      );
      if (gap >= 1.5) continue;
      if (SEED_IDS.has(jobs[i].job_id) && SEED_IDS.has(jobs[i - 1].job_id)) continue;
      if (stagedOnly.has(jobs[i].job_id) || stagedOnly.has(jobs[i - 1].job_id)) continue;
      bad(`double-book on ${techId}: ${jobs[i - 1].job_id}@${jobs[i - 1].scheduled_time} & ${jobs[i].job_id}@${jobs[i].scheduled_time} (${gap.toFixed(2)}h)`);
    }
  }

  const frozen = await repo.getJob("job_2001");
  if ((frozen?.reschedule_history.length ?? 0) > 0) bad("job_2001 (frozen) was rescheduled");
}

async function main() {
  console.log("═".repeat(60));
  console.log("CoolFix — concurrency probe");
  console.log("═".repeat(60));

  // A: two standard bookings, different areas — should both assign cleanly
  await run("two-standard", [
    { ...base, customer_name: "Con A1", customer_email: "a1@t.sg", address: "x", location: SG_LANDMARKS.clementi, problem_category: "routine", problem_description: "cleaning", tier: "standard" },
    { ...base, customer_name: "Con A2", customer_email: "a2@t.sg", address: "x", location: SG_LANDMARKS.tampines, problem_category: "routine", problem_description: "cleaning", tier: "standard" },
  ]);

  // B: two URGENT refrigerant near Bishan — both want the same scarce slot
  await run("two-urgent-same-slot", [
    { ...base, customer_name: "Con B1", customer_email: "b1@t.sg", address: "x", location: SG_LANDMARKS.bishan, problem_category: "not_cooling", problem_description: "refrigerant leak, no cooling, urgent", tier: "urgent" },
    { ...base, customer_name: "Con B2", customer_email: "b2@t.sg", address: "x", location: SG_LANDMARKS.bishan, problem_category: "not_cooling", problem_description: "refrigerant leak, no cooling, urgent", tier: "urgent" },
  ]);

  await reseed();
  console.log("\n" + "═".repeat(60));
  console.log(violations === 0 ? "RESULT: DB stayed consistent under concurrency ✓" : `RESULT: ${violations} consistency violation(s)`);
  console.log("═".repeat(60));
  process.exit(violations > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
