// POST /api/reset — demo "Reset" button. Wipes and re-seeds the DB.

import { NextResponse } from "next/server";
import * as repo from "@/lib/repo";
import { seedTechnicians, seedJobs, seedAgentActivity } from "@/data/seed";
import { DEFAULT_CONFIG } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST() {
  await repo.wipeAll();
  const techs = seedTechnicians();
  for (const t of techs) await repo.upsertTechnician(t);
  const jobs = seedJobs(DEFAULT_CONFIG.freezeWindowHours);
  for (const j of jobs) await repo.upsertJob(j);
  const { decisions, notifications } = seedAgentActivity(jobs, techs);
  for (const d of decisions) await repo.insertDecision(d);
  for (const n of notifications) await repo.insertNotification(n);
  await repo.updateConfig(DEFAULT_CONFIG);
  return NextResponse.json({ ok: true, message: "Reset to the initial demo state." });
}
