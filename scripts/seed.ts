// Seed / reset the Supabase database to the demo starting state.
//   npm run seed            → wipe + insert seed technicians & jobs
//   npm run seed -- --keep  → insert only if tables are empty
//
// Requires .env.local with SUPABASE_SERVICE_ROLE_KEY.

import "./_env";
import { seedTechnicians, seedJobs } from "../src/data/seed";
import { DEFAULT_CONFIG } from "../src/lib/types";
import * as repo from "../src/lib/repo";

async function main() {
  const keep = process.argv.includes("--keep");

  if (!keep) {
    process.stdout.write("Wiping existing data… ");
    await repo.wipeAll();
    console.log("done");
  } else {
    const existing = await repo.listJobs();
    if (existing.length > 0) {
      console.log(`--keep: ${existing.length} jobs already present, nothing to do.`);
      return;
    }
  }

  const techs = seedTechnicians();
  for (const t of techs) await repo.upsertTechnician(t);
  console.log(`Inserted ${techs.length} technicians.`);

  const jobs = seedJobs(DEFAULT_CONFIG.freezeWindowHours);
  for (const j of jobs) await repo.upsertJob(j);
  console.log(`Inserted ${jobs.length} jobs.`);

  await repo.updateConfig(DEFAULT_CONFIG);
  console.log("Reset runtime_config to defaults.");

  console.log("\nSeed complete. Start the app with `npm run dev`.");
}

main().catch((e) => {
  console.error("Seed failed:", e);
  process.exit(1);
});
