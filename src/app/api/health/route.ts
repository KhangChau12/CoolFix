// GET /api/health — deployment check + shows LLM mode & counts.

import { NextResponse } from "next/server";
import { hasSupabaseEnv } from "@/lib/supabase";
import { llmStats } from "@/lib/llm";
import * as repo from "@/lib/repo";

export const dynamic = "force-dynamic";

export async function GET() {
  const mode = process.env.LLM_MODE ?? "stub";
  const out: Record<string, unknown> = {
    ok: true,
    llm_mode: mode,
    llm_provider_ready:
      mode === "stub"
        ? true
        : mode === "gateway"
          ? Boolean(process.env.LLM_GATEWAY_API_KEY)
          : mode === "openai"
            ? Boolean(process.env.OPENAI_API_KEY)
            : false,
    llm_model:
      mode === "gateway"
        ? process.env.LLM_MODEL ?? "global.anthropic.claude-sonnet-4-5-20250929-v1:0"
        : mode === "openai"
          ? process.env.OPENAI_MODEL ?? "gpt-4o-mini"
          : null,
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
