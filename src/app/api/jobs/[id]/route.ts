// GET   /api/jobs/:id           — job detail (customer tracker, tech app).
// PATCH /api/jobs/:id           — technician status transitions.

import { NextResponse } from "next/server";
import * as repo from "@/lib/repo";
import type { JobStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

const TECH_TRANSITIONS: Record<string, JobStatus> = {
  en_route: "in_progress",
  arrived: "in_progress",
  completed: "completed",
};

// Finer-grained state within "in_progress" — see Job.tech_substatus. Cleared
// once the job moves past in_progress (nothing to distinguish once done).
const TECH_SUBSTATUS: Record<string, "en_route" | "arrived" | null> = {
  en_route: "en_route",
  arrived: "arrived",
  completed: null,
};

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const job = await repo.getJob(params.id);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  const tech = job.assigned_technician_id
    ? await repo.getTechnician(job.assigned_technician_id)
    : null;
  // Additive — existing consumers destructure `{ job, technician }` and
  // are unaffected. Customer feedback on this same job is not a leak of
  // someone else's data; the admin job-detail replay also reads it.
  const feedback = await repo.getFeedbackByJobId(job.job_id);
  return NextResponse.json({ job, technician: tech ?? null, feedback: feedback ?? null });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const job = await repo.getJob(params.id);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const action = String(b.action ?? "");
  const nextStatus = TECH_TRANSITIONS[action];
  if (!nextStatus) {
    return NextResponse.json(
      { error: "action must be en_route | arrived | completed" },
      { status: 400 },
    );
  }

  await repo.upsertJob({ ...job, status: nextStatus, tech_substatus: TECH_SUBSTATUS[action] });
  return NextResponse.json({ ok: true, status: nextStatus });
}
