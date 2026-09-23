// POST /api/technicians/:id/unavailable — admin-triggered disruption entry
// point: "this technician can't work the rest of today." Re-plans every one
// of their remaining, not-yet-started jobs (see
// runTechnicianUnavailable in agents/orchestrator.ts) and reports what
// happened to each — auto-reassigned, sent for approval, or unresolvable.
//
// Internal/admin surface (no request-supplied job/technician-target beyond
// the id in the URL; body is just an optional free-text reason), same trust
// boundary as the rest of /api/technicians — not exposed to /api/public/**.

import { NextResponse } from "next/server";
import { runTechnicianUnavailable } from "@/agents/orchestrator";

export const dynamic = "force-dynamic";

const MAX_REASON_LEN = 200;

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  let b: Record<string, unknown> = {};
  try {
    b = await req.json();
  } catch {
    // Empty body is fine — reason is optional.
  }

  const reason =
    typeof b.reason === "string" && b.reason.trim()
      ? b.reason.trim().slice(0, MAX_REASON_LEN)
      : "Marked unavailable by a coordinator";

  try {
    const result = await runTechnicianUnavailable(params.id, reason);
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    const status = message.startsWith("Unknown technician") ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
