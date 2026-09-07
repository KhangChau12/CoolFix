// GET  /api/approvals            — HITL queue.
// POST /api/approvals/:id/resolve is handled in [id]/resolve/route.ts

import { NextResponse } from "next/server";
import * as repo from "@/lib/repo";

export const dynamic = "force-dynamic";

export async function GET() {
  const approvals = await repo.listApprovals();
  return NextResponse.json({ approvals });
}
