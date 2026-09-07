// GET /api/health — deployment check + shows LLM mode & counts.

import { NextResponse } from "next/server";
import { hasSupabaseEnv } from "@/lib/supabase";
import { llmStats } from "@/lib/llm";
import * as repo from "@/lib/repo";

export const dynamic = "force-dynamic";

export async function GET() {
  const out: Record<string, unknown> = {
    ok: true,
    llm_mode: process.env.LLM_MODE ?? "stub",
    supabase_env: hasSupabaseEnv(),
    llm: llmStats(),
  };
  try {
    const [jobs, techs, decisions] = await Promise.all([
      repo.listJobs(),
      repo.listTechnicians(),
      repo.listDecisions(1),
    ]);
    out.db = { jobs: jobs.length, technicians: techs.length, has_decisions: decisions.length > 0 };
  } catch (e) {
    out.ok = false;
    out.db_error = e instanceof Error ? e.message : String(e);
  }
  return NextResponse.json(out);
}
