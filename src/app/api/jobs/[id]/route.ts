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

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const job = await repo.getJob(params.id);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  const tech = job.assigned_technician_id
    ? await repo.getTechnician(job.assigned_technician_id)
    : null;
  return NextResponse.json({ job, technician: tech ?? null });
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

  await repo.upsertJob({ ...job, status: nextStatus });
  return NextResponse.json({ ok: true, status: nextStatus });
}
