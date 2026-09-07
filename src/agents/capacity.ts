// ── Capacity/Yield Agent ────────────────────────────────────────────
// MVP: hard-threshold rules (CLAUDE.md §4, §7). No LLM.
// Decides whether the fleet can absorb this booking today, or whether to
// warn / suggest another slot. Thresholds live in RuntimeConfig so the
// Settings screen can tune them (Observability point).

import { hoursBetween, nowISO } from "@/lib/time";
import { logDecision } from "./log";
import type { CapacityResult } from "./schemas";
import type { Tier } from "@/lib/types";
import type { AgentContext } from "./context";

export function runCapacityAgent(
  ctx: AgentContext,
  args: { jobId: string; tier: Tier; proposedSlotHours: number },
): CapacityResult {
  const cfg = ctx.config;
  const now = nowISO();

  // Count jobs scheduled within the next 24h (a rough "today" window).
  const active = ctx.jobs.filter(
    (j) =>
      j.job_id !== args.jobId &&
      j.status !== "completed" &&
      j.status !== "disrupted" &&
      hoursBetween(now, j.scheduled_time) >= -1 &&
      hoursBetween(now, j.scheduled_time) <= 24,
  );
  const totalToday = active.length;
  const flexibleToday = active.filter((j) => j.tier === "flexible").length;

  let decision: CapacityResult["decision"] = "accept";
  let reason = "Spare capacity available — accepting the booking normally.";
  let altSlot: number | null = null;

  if (args.tier === "flexible" && flexibleToday >= cfg.capacityFlexiblePerDay) {
    decision = "suggest_alternative_slot";
    altSlot = Math.max(args.proposedSlotHours, 30) + 24;
    reason = `Daily cap of ${cfg.capacityFlexiblePerDay} Flexible jobs reached — proposing a later slot.`;
  } else if (totalToday >= cfg.capacityTotalPerDay) {
    decision =
      args.tier === "urgent" ? "accept_with_warning" : "suggest_alternative_slot";
    if (decision === "accept_with_warning") {
      reason = `Schedule nearly full (${totalToday}/${cfg.capacityTotalPerDay}) but Urgent jobs are still accepted — a soft job may need to move.`;
    } else {
      altSlot = args.proposedSlotHours + 24;
      reason = `Schedule full (${totalToday}/${cfg.capacityTotalPerDay}) — proposing a slot on the next day.`;
    }
  } else if (totalToday >= cfg.capacityTotalPerDay * 0.8) {
    decision = "accept_with_warning";
    reason = `Schedule at ${Math.round(
      (totalToday / cfg.capacityTotalPerDay) * 100,
    )}% capacity — accepting but monitoring.`;
  }

  const out: CapacityResult = {
    decision,
    reason,
    alternative_slot_hours: altSlot,
    utilisation: { total_today: totalToday, flexible_today: flexibleToday },
  };

  logDecision(ctx, {
    agent: "CapacityAgent",
    jobId: args.jobId,
    reasoningKind: "rule",
    input: {
      tier: args.tier,
      proposed_slot_hours: args.proposedSlotHours,
      total_today: totalToday,
      flexible_today: flexibleToday,
      caps: { total: cfg.capacityTotalPerDay, flexible: cfg.capacityFlexiblePerDay },
    },
    output: out as unknown as Record<string, unknown>,
    headline: `Capacity: ${decision} (${totalToday}/${cfg.capacityTotalPerDay} today)`,
    outcome: decision === "accept" ? "auto_commit" : "info",
    guardrailNotes: ["Hard thresholds from config — no LLM call."],
  });

  return out;
}
