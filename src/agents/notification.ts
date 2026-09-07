// ── Notification Agent ──────────────────────────────────────────────
// LLM call. Composes natural, context-aware messages for the technician
// app and the customer email. This is one of the few places free-text
// output is intentional (CLAUDE.md §4).
//
// Guardrail: the agent only receives already-structured, sanitised job
// facts — never the raw customer description — so it cannot be steered
// by injected content, and it cannot leak PII it was never given.

import { callLlm } from "@/lib/llm";
import { fmtSGDateTime } from "@/lib/time";
import { logDecision } from "./log";
import { validateNotificationDraft } from "./schemas";
import { TIER_META } from "@/lib/types";
import type { NotificationRecord } from "@/lib/types";
import type { AgentContext } from "./context";

type Kind = NotificationRecord["kind"];

const SYSTEM = `You are the Notification Agent for CoolFix. Write short, polite messages in English.
- technician_app channel: terse, action-first (new job / reschedule), remind them to tap "Seen".
- customer_email channel: friendly, with a greeting and a "The CoolFix team" sign-off; explain the reason if rescheduling.
- Do NOT invent information beyond what you are given. Do NOT add phone numbers or prices that aren't in the input.`;

const SCHEMA = `{"channel":"technician_app|customer_email","subject":string,"body":string}`;

export interface NotifyInput {
  jobId: string;
  channel: "technician_app" | "customer_email";
  kind: Kind;
  change?: { fromISO: string; toISO: string; reason: string };
}

export async function runNotificationAgent(
  ctx: AgentContext,
  input: NotifyInput,
): Promise<NotificationRecord> {
  const job = ctx.getJob(input.jobId)!;
  const tech = job.assigned_technician_id
    ? ctx.getTechnician(job.assigned_technician_id)
    : null;

  const resp = await callLlm({
    task: "notification_compose",
    system: SYSTEM,
    structuredInput: {
      channel: input.channel,
      kind: input.kind,
      job: {
        job_id: job.job_id,
        customer_name: job.customer_name,
        address: job.location.address,
        scheduled_time_local: fmtSGDateTime(job.scheduled_time),
        tier_label: TIER_META[job.tier].label,
        technician_name: tech?.name,
      },
      change: input.change
        ? {
            from_local: fmtSGDateTime(input.change.fromISO),
            to_local: fmtSGDateTime(input.change.toISO),
            reason: input.change.reason,
          }
        : undefined,
    },
    expectedSchema: SCHEMA,
  });

  const draft = validateNotificationDraft(resp.data);

  const record: NotificationRecord = {
    notification_id: `ntf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    created_at: new Date().toISOString(),
    channel: input.channel,
    recipient_id:
      input.channel === "technician_app"
        ? (tech?.technician_id ?? "unassigned")
        : job.customer_email,
    job_id: job.job_id,
    kind: input.kind,
    subject: draft.subject,
    body: draft.body,
    acknowledged: false,
    acknowledged_at: null,
  };

  logDecision(ctx, {
    agent: "NotificationAgent",
    jobId: job.job_id,
    reasoningKind: "llm",
    input: {
      channel: input.channel,
      kind: input.kind,
      llm_mode: resp.mode,
      cached: resp.cached,
    },
    output: { subject: draft.subject, body_preview: draft.body.slice(0, 120) },
    headline: `Sent to ${input.channel === "technician_app" ? "technician" : "customer"}: ${draft.subject}`,
    outcome: "auto_commit",
    latencyMs: resp.latency_ms,
    guardrailNotes: [
      ...resp.guardrail_notes,
      "Agent receives only structured job facts — never the raw customer description.",
    ],
  });

  return record;
}
