import { NextResponse } from "next/server";
import { rollbackAdaptiveRecommendation } from "@/lib/adaptivePolicy";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const actor = String(body.actor ?? req.headers.get("x-coordinator-name") ?? "demo coordinator").trim().slice(0, 120) || "demo coordinator";
    return NextResponse.json({ recommendation: await rollbackAdaptiveRecommendation(params.id, actor) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to roll back recommendation." }, { status: 409 });
  }
}
