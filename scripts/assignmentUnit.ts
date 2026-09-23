// Pure-logic unit tests for the Assignment Agent's ambiguity detector —
// no DB, no LLM, no seed data needed.
//
//   npx tsx scripts/assignmentUnit.ts
//
// `detectAmbiguity` (src/agents/assignmentTiebreak.ts) decides whether the
// formula's ranking is close enough to warrant handing the pick to the LLM
// tie-break agent — this is what makes "ambiguous assignment" a genuinely
// agentic decision rather than always just taking the top score. Nothing
// in the existing eval/fuzz/robustness suites exercises this function
// directly (they test full pipeline runs, which only trigger tiebreak by
// coincidence of the scored candidates); this fills that gap.

import { detectAmbiguity } from "../src/agents/assignmentTiebreak";
import type { CandidateScore, ScoreBreakdown } from "../src/lib/types";

let failures = 0;
function check(name: string, cond: unknown) {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}`);
  }
}
function line(s: string) {
  console.log("\n" + "─".repeat(70) + "\n" + s + "\n" + "─".repeat(70));
}

function candidate(id: string, total: number, eligible = true): CandidateScore {
  const breakdown: ScoreBreakdown = {
    travel: total * 0.3,
    skill_fit: total * 0.3,
    availability: total * 0.2,
    sla_headroom: total * 0.1,
    load_balance: total * 0.1,
    customer_satisfaction: 0,
    total,
  };
  return {
    technician_id: id,
    technician_name: id,
    eligible,
    reject_reason: eligible ? null : "not eligible",
    breakdown: eligible ? breakdown : null,
  };
}

async function main() {
  line("1. Close top-two scores (within 10%) — should trigger");
  {
    const trigger = detectAmbiguity([candidate("a", 0.80), candidate("b", 0.75), candidate("c", 0.40)], {
      tier: "standard",
    });
    check("a genuine near-tie is flagged", trigger?.code === "close_scores");
  }

  line("2. Clear winner — should NOT trigger (the common case)");
  {
    const trigger = detectAmbiguity([candidate("a", 0.90), candidate("b", 0.50), candidate("c", 0.30)], {
      tier: "standard",
    });
    check("a decisive top score never invokes the LLM", trigger === null);
  }

  line("3. Single eligible candidate, urgent tier, weak fit — should trigger");
  {
    const trigger = detectAmbiguity([candidate("a", 0.30)], { tier: "urgent" });
    check("a weak lone match on an urgent job is flagged", trigger?.code === "urgent_weak_fit");
  }

  line("4. Single eligible candidate, urgent tier, strong fit — should NOT trigger");
  {
    const trigger = detectAmbiguity([candidate("a", 0.85)], { tier: "urgent" });
    check("a strong lone match is trusted without the LLM", trigger === null);
  }

  line("5. Single eligible candidate, non-urgent tier — should NOT trigger even if weak");
  {
    const trigger = detectAmbiguity([candidate("a", 0.20)], { tier: "flexible" });
    check("the weak-fit escalation is urgent-tier only", trigger === null);
  }

  line("6. Edge cases — no eligible candidates, ineligible rows ignored");
  {
    check("zero candidates never crashes and never triggers", detectAmbiguity([], { tier: "urgent" }) === null);
    const trigger = detectAmbiguity(
      [candidate("a", 0.80, false), candidate("b", 0.78), candidate("c", 0.10, false)],
      { tier: "standard" },
    );
    check("ineligible rows are excluded from the tie check (only one real eligible candidate here)", trigger === null);
  }

  line("RESULT");
  if (failures === 0) {
    console.log("All checks passed.");
  } else {
    console.log(`${failures} check(s) FAILED.`);
    process.exitCode = 1;
  }
}

main();
