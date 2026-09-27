// GET /api/decisions?limit=200        — Agent Reasoning Feed data.
// GET /api/decisions?job=job_xyz      — just that job's pipeline, oldest → newest
//                                       (the per-job "pipeline replay" view).
// (The browser also subscribes to realtime inserts directly; this is the
// initial page load + a polling fallback.)

import { NextResponse } from "next/server";
import * as repo from "@/lib/repo";
import { sortPipelineOrder } from "@/lib/flowMap";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const requestedLimit = Number(url.searchParams.get("limit") ?? 200);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(Math.floor(requestedLimit), 500)) : 200;
  const jobId = url.searchParams.get("job");

  let decisions = await repo.listDecisions(limit, jobId ?? undefined);
  if (jobId) {
    // Share the UI's ordering, including frozen demo timestamps and
    // sequence counters that restart between booking and approval workers.
    decisions = sortPipelineOrder(decisions);
  }
  return NextResponse.json({ decisions });
}
