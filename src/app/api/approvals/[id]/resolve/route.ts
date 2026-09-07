// POST /api/approvals/:id/resolve — coordinator Approve / Reject.
// Body: { decision: "approve" | "reject", chosenOptionId?: string, coordinatorName?: string }

import { NextResponse } from "next/server";
import { resolveApproval } from "@/agents/approval";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (b.decision !== "approve" && b.decision !== "reject") {
    return NextResponse.json({ error: "decision must be approve|reject" }, { status: 400 });
  }

  const result = await resolveApproval({
    approvalId: params.id,
    decision: b.decision,
    chosenOptionId: typeof b.chosenOptionId === "string" ? b.chosenOptionId : undefined,
    coordinatorName: typeof b.coordinatorName === "string" ? b.coordinatorName : "Coordinator",
  });

  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}
