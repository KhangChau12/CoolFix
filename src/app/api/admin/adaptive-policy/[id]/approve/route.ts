import { NextResponse } from "next/server";
import { approveAdaptiveRecommendation } from "@/lib/adaptivePolicy";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  return mutate(req, params.id, "approve");
}

async function mutate(req: Request, id: string, action: string) {
  try {
    const body = await safeBody(req);
    const actor = actorName(body, req);
    const recommendation = await approveAdaptiveRecommendation(id, actor);
    return NextResponse.json({ recommendation });
  } catch (error) {
    return fail(error, action);
  }
}

async function safeBody(req: Request): Promise<Record<string, unknown>> {
  try { return await req.json(); } catch { return {}; }
}

function actorName(body: Record<string, unknown>, req: Request): string {
  const raw = body.actor ?? req.headers.get("x-coordinator-name") ?? "demo coordinator";
  return String(raw).trim().slice(0, 120) || "demo coordinator";
}

function fail(error: unknown, action: string) {
  return NextResponse.json({ error: error instanceof Error ? error.message : `Unable to ${action} recommendation.` }, { status: 409 });
}
