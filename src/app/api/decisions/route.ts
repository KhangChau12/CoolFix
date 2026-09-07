// GET /api/decisions?limit=200        — Agent Reasoning Feed data.
// GET /api/decisions?job=job_xyz      — just that job's pipeline, oldest → newest
//                                       (the per-job "pipeline replay" view).
// (The browser also subscribes to realtime inserts directly; this is the
// initial page load + a polling fallback.)

import { NextResponse } from "next/server";
import * as repo from "@/lib/repo";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 500);
  const jobId = url.searchParams.get("job");

  let decisions = await repo.listDecisions(limit);
  if (jobId) {
    // Filter to one job and return it in true pipeline order. Timestamps
    // tie at 1s resolution, so several agents in the same run share one —
    // ordering on timestamp alone reverses those. log_id ends in
    // `_<base36 monotonic seq>` (see agents/log.ts), which is a reliable
    // per-run ordering key.
    const seqOf = (id: string) => {
      const tail = id.split("_").pop() ?? "0";
      const n = parseInt(tail, 36);
      return Number.isFinite(n) ? n : 0;
    };
    decisions = decisions
      .filter((d) => d.job_id === jobId)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || seqOf(a.log_id) - seqOf(b.log_id));
  }
  return NextResponse.json({ decisions });
}
