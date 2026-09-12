// POST /api/reset — demo "Reset" button. Wipes and re-seeds the DB.

import { NextResponse } from "next/server";
import * as repo from "@/lib/repo";
import { seedTechnicians, seedJobs, seedAgentActivity, seedFeedback } from "@/data/seed";
import { DEFAULT_CONFIG } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST() {
  // Reset the demo data without silently changing the coordinator's selected
  // scheduling clock. The clock remains simulated until they choose real time
  // in Settings.
  const currentConfig = await repo.getConfig();
  const resetConfig = {
    ...DEFAULT_CONFIG,
    clockMode: currentConfig.clockMode,
    customTimeISO: currentConfig.customTimeISO,
  };
  await repo.wipeAll();
  const techs = seedTechnicians();
  for (const t of techs) await repo.upsertTechnician(t);
  const jobs = seedJobs(resetConfig.freezeWindowHours);
  for (const j of jobs) await repo.upsertJob(j);
  const { decisions, notifications } = seedAgentActivity(jobs, techs);
  for (const d of decisions) await repo.insertDecision(d);
  for (const n of notifications) await repo.insertNotification(n);
  for (const f of seedFeedback(jobs)) await repo.insertFeedbackIfAbsent(f);
  await repo.updateConfig(resetConfig);
  return NextResponse.json({ ok: true, message: "Reset to the initial demo state." });
}
