// ── Pricing Engine ──────────────────────────────────────────────────
// RULE-BASED ONLY. No LLM. Deliberate architecture decision (CLAUDE.md
// §4): pricing must be deterministic, auditable, and free. An LLM here
// would add cost, latency, and non-determinism for zero benefit.

import { TIER_META, type SkillTag, type Tier } from "@/lib/types";
import { logDecision } from "./log";
import type { AgentContext } from "./context";

export interface PricingOutput {
  price: number;
  base_price: number;
  tier_multiplier: number;
  currency: "SGD";
  breakdown: string;
}

export function runPricingEngine(
  ctx: AgentContext,
  args: { jobId: string; skillRequired: SkillTag[]; tier: Tier },
): PricingOutput {
  const cfg = ctx.config;
  // Base price = the most specialised skill the job needs.
  const base = Math.max(...args.skillRequired.map((s) => cfg.basePrice[s]));
  const mult = TIER_META[args.tier].priceMultiplier;
  const price = Math.round(base * mult);

  const out: PricingOutput = {
    price,
    base_price: base,
    tier_multiplier: mult,
    currency: "SGD",
    breakdown: `${base} SGD × ${mult} (${TIER_META[args.tier].label}) = ${price} SGD`,
  };

  logDecision(ctx, {
    agent: "PricingEngine",
    jobId: args.jobId,
    reasoningKind: "rule",
    input: { skill_required: args.skillRequired, tier: args.tier },
    output: out as unknown as Record<string, unknown>,
    headline: `Priced at ${price} SGD (${TIER_META[args.tier].labelEn})`,
    outcome: "auto_commit",
    guardrailNotes: ["Rule-based — no LLM call (deliberate architecture decision)."],
  });

  return out;
}
