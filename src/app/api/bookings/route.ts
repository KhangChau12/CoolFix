// POST /api/bookings — Customer form submit → runs the agent pipeline.
// GET  /api/bookings — list jobs (for Admin queue / calendar).

import { NextResponse } from "next/server";
import { runBookingPipeline } from "@/agents/orchestrator";
import * as repo from "@/lib/repo";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body is not valid JSON" }, { status: 400 });
  }

  try {
    const result = await runBookingPipeline(body);
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    // Schema errors are the client's fault; everything else is 500.
    const status = msg.startsWith("[schema:") ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export async function GET() {
  const jobs = await repo.listJobs();
  return NextResponse.json({ jobs });
}
