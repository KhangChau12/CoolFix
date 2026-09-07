// POST /api/reset — demo "Reset" button. Wipes and re-seeds the DB.

import { NextResponse } from "next/server";
import * as repo from "@/lib/repo";
import { seedTechnicians, seedJobs } from "@/data/seed";
import { DEFAULT_CONFIG } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST() {
  await repo.wipeAll();
  for (const t of seedTechnicians()) await repo.upsertTechnician(t);
  for (const j of seedJobs(DEFAULT_CONFIG.freezeWindowHours)) await repo.upsertJob(j);
  await repo.updateConfig(DEFAULT_CONFIG);
  return NextResponse.json({ ok: true, message: "Reset to the initial demo state." });
}
