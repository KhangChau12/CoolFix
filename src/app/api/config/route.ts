// GET  /api/config — Settings screen load.
// PATCH /api/config — update weights / thresholds / prices.

import { NextResponse } from "next/server";
import * as repo from "@/lib/repo";
import type { RuntimeConfig, ScoreComponent, Tier } from "@/lib/types";
import { DISPATCH_POLICY, SCORE_COMPONENTS, TIERS } from "@/lib/types";

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
  if (b.dispatchPolicy) {
    // Per-tier scoring policy: clamp every weight to [0,1] and normalise
    // each tier's row to sum to 1, so `total` stays a readable [0,1] score.
    // A missing/garbled tier row falls back to the shipped default.
    const src = b.dispatchPolicy as Partial<
      Record<Tier, Partial<Record<ScoreComponent, number>>>
    >;
    const out = {} as RuntimeConfig["dispatchPolicy"];
    for (const tier of TIERS) {
      const row = src[tier];
      const raw = SCORE_COMPONENTS.map((k) =>
        clamp(Number(row?.[k] ?? DISPATCH_POLICY[tier][k]), 0, 1),
      );
      const sum = raw.reduce((s, v) => s + v, 0) || 1;
      out[tier] = SCORE_COMPONENTS.reduce(
        (acc, k, i) => ({ ...acc, [k]: round3(raw[i] / sum) }),
        {} as Record<ScoreComponent, number>,
      );
    }
    patch.dispatchPolicy = out;
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
  if (b.llmMode === "stub" || b.llmMode === "gateway" || b.llmMode === "openai")
    patch.llmMode = b.llmMode;

  const config = await repo.updateConfig(patch);
  return NextResponse.json({ config });
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.min(Math.max(n, lo), hi);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
