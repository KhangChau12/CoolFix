// GET  /api/config — Settings screen load.
// PATCH /api/config — update weights / thresholds / prices.

import { NextResponse } from "next/server";
import * as repo from "@/lib/repo";
import type { RuntimeConfig } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const config = await repo.getConfig();
  return NextResponse.json({ config });
}

export async function PATCH(req: Request) {
  let b: Partial<RuntimeConfig>;
  try {
    b = (await req.json()) as Partial<RuntimeConfig>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Whitelist + clamp — never trust the client to keep the system sane.
  const patch: Partial<RuntimeConfig> = {};
  if (typeof b.freezeWindowHours === "number")
    patch.freezeWindowHours = clamp(b.freezeWindowHours, 0.5, 24);
  if (b.scoreWeights) {
    patch.scoreWeights = {
      w1: clamp(Number(b.scoreWeights.w1), 0, 10),
      w2: clamp(Number(b.scoreWeights.w2), 0, 10),
      w3: clamp(Number(b.scoreWeights.w3), 0, 10),
      w4: clamp(Number(b.scoreWeights.w4), 0, 10),
    };
  }
  if (typeof b.hitlMaxCustomersAffected === "number")
    patch.hitlMaxCustomersAffected = clamp(b.hitlMaxCustomersAffected, 0, 20);
  if (typeof b.hitlMaxAddedTravelKm === "number")
    patch.hitlMaxAddedTravelKm = clamp(b.hitlMaxAddedTravelKm, 0, 100);
  if (typeof b.capacityFlexiblePerDay === "number")
    patch.capacityFlexiblePerDay = clamp(b.capacityFlexiblePerDay, 0, 100);
  if (typeof b.capacityTotalPerDay === "number")
    patch.capacityTotalPerDay = clamp(b.capacityTotalPerDay, 1, 500);
  if (b.basePrice) patch.basePrice = b.basePrice;
  if (b.llmMode === "stub" || b.llmMode === "bedrock") patch.llmMode = b.llmMode;

  const config = await repo.updateConfig(patch);
  return NextResponse.json({ config });
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.min(Math.max(n, lo), hi);
}
