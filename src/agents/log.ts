// Helper for building structured decision-log rows. Every agent calls
// this exactly once per invocation and buffers the row on the context;
// AgentContext.flush() persists them in order. The feed is only as good
// as the discipline here.

import { nowISO } from "@/lib/time";
import type {
  AgentDecisionLog,
  AgentName,
  CandidateScore,
  DecisionOutcome,
  ReplanOption,
  ScoreBreakdown,
} from "@/lib/types";
import type { AgentContext } from "./context";

let seq = 0;
function logId(): string {
  seq += 1;
  return `log_${Date.now().toString(36)}_${seq.toString(36)}`;
}

export interface LogInput {
  agent: AgentName;
  jobId: string;
  reasoningKind: "llm" | "rule";
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  headline: string;
  outcome: DecisionOutcome;
  requiresApproval?: boolean;
  approvedBy?: string | null;
  latencyMs?: number;
  guardrailNotes?: string[];
  scoreBreakdown?: ScoreBreakdown | null;
  candidates?: CandidateScore[] | null;
  replanOptions?: ReplanOption[] | null;
}

export function logDecision(ctx: AgentContext, i: LogInput): AgentDecisionLog {
  const entry: AgentDecisionLog = {
    log_id: logId(),
    timestamp: nowISO(),
    agent_name: i.agent,
    job_id: i.jobId,
    reasoning_kind: i.reasoningKind,
    input_summary: i.input,
    output_summary: i.output,
    score_breakdown: i.scoreBreakdown ?? null,
    candidates: i.candidates ?? null,
    replan_options: i.replanOptions ?? null,
    requires_human_approval: i.requiresApproval ?? false,
    outcome: i.outcome,
    approved_by: i.approvedBy ?? null,
    headline: i.headline,
    latency_ms: i.latencyMs ?? 0,
    guardrail_notes: i.guardrailNotes ?? [],
  };
  ctx.bufferDecision(entry);
  return entry;
}
