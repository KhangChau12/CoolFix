// GET  /api/public/jobs/:token/feedback — has feedback been submitted yet?
// POST /api/public/jobs/:token/feedback — submit feedback for a completed job.
//
// Same trust model as the parent tracking endpoint: the tracking token is
// the only authorization mechanism, resolved once via
// `repo.getJobByTrackingToken` (never a job_id/technician_id supplied by
// the client). Everything the customer is allowed to control is exactly
// the body `validateFeedbackSubmission` accepts — rating, tags, comment.
// The job_id and technician_id on the stored row are always derived from
// the authenticated job record, never echoed back from the request.

import { NextResponse } from "next/server";
import * as repo from "@/lib/repo";
import { isValidTrackingTokenFormat } from "@/lib/trackingTokenFormat";
import { validateFeedbackSubmission, type FeedbackValidationError } from "@/lib/feedback";
import type { Job, JobFeedback } from "@/lib/types";

export const dynamic = "force-dynamic";

const NOT_FOUND = {
  error: "Tracking code not found. Please check the code and try again.",
};
const NOT_ELIGIBLE = {
  error: "Feedback isn't available for this booking yet.",
};
const ALREADY_SUBMITTED = {
  error: "Feedback has already been submitted for this booking.",
};

const VALIDATION_MESSAGE: Record<FeedbackValidationError, string> = {
  invalid_payload: "That submission wasn't valid. Please try again.",
  invalid_rating: "Please choose a rating from 1 to 5 stars.",
  invalid_tags: "One of the selected tags isn't recognised. Please refresh and try again.",
  comment_too_long: "Comment is too long — please keep it under 500 characters.",
};

/** Resolve `token` → job, the same fail-closed way the parent tracking
 *  route does (malformed token, unknown token, and a DB error all produce
 *  the identical generic 404 — never distinguishable from outside). */
async function resolveJob(token: string): Promise<Job | null> {
  if (!isValidTrackingTokenFormat(token)) return null;
  try {
    return (await repo.getJobByTrackingToken(token)) ?? null;
  } catch (e) {
    console.error("[public/jobs/feedback] lookup failed", e instanceof Error ? e.message : e);
    return null;
  }
}

function isEligible(job: Job): boolean {
  return job.status === "completed" && !!job.assigned_technician_id;
}

function publicFeedback(f: JobFeedback) {
  return {
    rating: f.rating,
    positive_tags: f.positive_tags,
    improvement_tags: f.improvement_tags,
    comment: f.comment,
    created_at: f.created_at,
  };
}

export async function GET(_req: Request, { params }: { params: { token: string } }) {
  const job = await resolveJob(params.token ?? "");
  if (!job) return NextResponse.json(NOT_FOUND, { status: 404 });

  const eligible = isEligible(job);
  const existing = eligible ? await repo.getFeedbackByJobId(job.job_id) : undefined;

  return NextResponse.json({
    eligible,
    submitted: !!existing,
    feedback: existing ? publicFeedback(existing) : null,
  });
}

export async function POST(req: Request, { params }: { params: { token: string } }) {
  const job = await resolveJob(params.token ?? "");
  if (!job) return NextResponse.json(NOT_FOUND, { status: 404 });

  if (!isEligible(job)) {
    return NextResponse.json(NOT_ELIGIBLE, { status: 409 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: VALIDATION_MESSAGE.invalid_payload }, { status: 400 });
  }

  const validated = validateFeedbackSubmission(raw);
  if (!validated.ok) {
    return NextResponse.json({ error: VALIDATION_MESSAGE[validated.error] }, { status: 400 });
  }

  // Pre-check for a fast, friendly error on the common case (customer hits
  // submit twice) — the actual race-safe guarantee is the unique index on
  // job_feedback.job_id, enforced in insertFeedbackIfAbsent below.
  const already = await repo.getFeedbackByJobId(job.job_id);
  if (already) {
    return NextResponse.json(ALREADY_SUBMITTED, { status: 409 });
  }

  const feedback: JobFeedback = {
    feedback_id: `fb_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    job_id: job.job_id,
    // Derived from the job record, never from the request body — the job's
    // assigned_technician_id at completion is, by construction, whoever
    // actually did the work (a completed job is never reassigned; see
    // JobFeedback's doc comment in lib/types.ts).
    technician_id: job.assigned_technician_id!,
    rating: validated.value.rating,
    positive_tags: validated.value.positive_tags,
    improvement_tags: validated.value.improvement_tags,
    comment: validated.value.comment,
    created_at: new Date().toISOString(),
  };

  const result = await repo.insertFeedbackIfAbsent(feedback);
  if (!result.ok) {
    if (result.reason === "unavailable") {
      return NextResponse.json(
        { error: "Feedback isn't available right now. Please try again later." },
        { status: 503 },
      );
    }
    return NextResponse.json(ALREADY_SUBMITTED, { status: 409 });
  }

  await logFeedbackEvent(result.feedback);

  return NextResponse.json({ ok: true, feedback: publicFeedback(result.feedback) }, { status: 201 });
}

/** A single, lightweight row in the existing decision/reasoning feed —
 *  "Alex received 5★ feedback" — so the event is visible to a coordinator
 *  without treating post-service feedback as a pipeline agent (it isn't
 *  one: no AgentContext, no scoring, no schedule mutation). Reuses the
 *  "Orchestrator" agent_name already in the enum for other system-level,
 *  non-agent-specific events ("New booking received", auto-commit rows).
 *  Deliberately excludes the free-text comment — only the rating and tag
 *  counts, which are structured facts, not customer free text. */
async function logFeedbackEvent(f: JobFeedback): Promise<void> {
  const tech = await repo.getTechnician(f.technician_id);
  const name = tech?.name ?? "the technician";
  const stars = "★".repeat(f.rating) + "☆".repeat(5 - f.rating);
  try {
    await repo.insertDecision({
      log_id: `log_${Date.now().toString(36)}_fb${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      agent_name: "Orchestrator",
      job_id: f.job_id,
      reasoning_kind: "rule",
      input_summary: { rating: f.rating },
      output_summary: {
        technician_id: f.technician_id,
        positive_tags: f.positive_tags,
        improvement_tags: f.improvement_tags,
      },
      requires_human_approval: false,
      outcome: "info",
      approved_by: null,
      headline: `Customer feedback received — ${name} got ${stars} (${f.rating}/5)`,
      latency_ms: 0,
      guardrail_notes: [
        "Post-service event, not a scheduling decision — logged for visibility only.",
      ],
    });
  } catch (e) {
    // Never fail the customer's submission because the feed row didn't
    // write — the feedback itself is already durably committed above.
    console.error("[public/jobs/feedback] decision-log insert failed", e instanceof Error ? e.message : e);
  }
}
