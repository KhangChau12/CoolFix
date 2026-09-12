// ── Customer-safe job view ──────────────────────────────────────────
// Turns an internal `Job` (+ its assigned `Technician`, if any) into the
// sanitized shape served by `GET /api/public/jobs/:token` and rendered by
// `/track/:token`. This is the ONE place that decides what a customer is
// allowed to see — no route or component should hand a raw `Job` /
// `Technician` row to the browser.
//
// Deliberately excluded, even though it exists on the internal record:
// technician phone/id, score_breakdown, candidate lists, replan options,
// agent decision rows, runtime config, any other job's data.

import { SKILL_LABEL, TIER_META, type Job, type Technician } from "./types";
import { hoursBetween, nowISO } from "./time";
import type { TechnicianRatingSummary } from "./rating";

export interface PublicTimelineStep {
  key: string;
  label: string;
  state: "done" | "current" | "upcoming";
}

export interface PublicJobView {
  trackingToken: string;
  status: string;
  statusLabel: string;
  message: string;
  appointment: {
    date: string; // "2026-09-12"
    start: string; // "15:30"
    end: string; // "17:00" (best-effort +2h display window)
  };
  service: {
    category: string;
    summary: string;
  };
  technician: {
    name: string;
    specialty: string;
  } | null;
  location: { lat: number; lng: number };
  technicianLocation: { lat: number; lng: number } | null;
  eta: number | null; // minutes, only while a technician is assigned/en route
  price: number;
  timeline: PublicTimelineStep[];
  explanation: string | null;
  disruption: { headline: string; detail: string } | null;
  trackingCode: string;
  /** True only once the job is completed AND has an assigned technician —
   *  the two things `/api/public/jobs/:token/feedback` requires server-side
   *  before accepting a submission. The client uses this to decide whether
   *  to even ask the feedback endpoint for status, not as the actual
   *  authorization (that check is re-done, from scratch, on every feedback
   *  request). */
  feedbackEligible: boolean;
}

const SPECIALTY_LABEL: Record<Technician["experience_level"], string> = {
  senior: "Senior technician",
  junior: "Technician",
};

/** One skill-derived "specialty" label, customer-friendly (no raw tag). */
function specialtyFor(tech: Technician): string {
  const skillLabels = tech.skill_tags.map((s) => SKILL_LABEL[s]);
  const headline = skillLabels[0] ?? "General servicing";
  return `${headline} · ${SPECIALTY_LABEL[tech.experience_level]}`;
}

/** SGT calendar date / time-of-day strings for the appointment block. */
function sgDateParts(iso: string): { date: string; time: string } {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
  return { date, time };
}

function addMinutesLabel(iso: string, minutes: number): string {
  const d = new Date(new Date(iso).getTime() + minutes * 60_000);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

// Visit-length estimate for the display-only appointment window — matches
// the same duration table the pipeline itself uses for scheduling.
const DEFAULT_VISIT_MIN = 90;

interface StatusInfo {
  code: string;
  label: string;
  message: string;
}

/** The single source of truth for "what does the customer see right now",
 *  derived only from fields already on the job (status, pipeline_stage,
 *  tech_substatus, reschedule_history) — never from agent reasoning. */
function deriveStatus(job: Job): StatusInfo {
  if (job.status === "completed") {
    return { code: "completed", label: "Service completed", message: "Your service is complete. Thanks for choosing CoolFix!" };
  }
  if (job.status === "in_progress") {
    if (job.tech_substatus === "arrived") {
      return { code: "arrived", label: "Technician has arrived", message: "Your technician has arrived and is starting work." };
    }
    return { code: "en_route", label: "Technician is on the way", message: "Your technician is on the way to your appointment." };
  }
  if (job.pipeline_stage === "awaiting_approval") {
    // The orchestrator sets status "pending" for BOTH cases below, so the
    // real discriminator is whether a technician is tentatively held on the
    // job: a re-plan/disruption approval keeps `assigned_technician_id` set
    // (see orchestrator.ts §4d) while a "no technician found" escalation
    // clears it.
    if (job.assigned_technician_id) {
      return {
        code: "reviewing_change",
        label: "We're adjusting your appointment",
        message: "We're reviewing a schedule change for your booking. This page updates automatically once it's confirmed.",
      };
    }
    return {
      code: "reviewing_request",
      label: "We're reviewing your request",
      message: "A coordinator is reviewing your request to make sure everything is set up right.",
    };
  }
  if (job.status === "assigned" || job.status === "frozen") {
    return { code: "assigned", label: "Technician assigned", message: "A certified technician has been assigned to your booking." };
  }
  switch (job.pipeline_stage) {
    case "intake":
      return { code: "request_received", label: "Request received", message: "We've received your request and are getting started." };
    case "pricing":
      return { code: "preparing_service", label: "Preparing your service", message: "We're preparing your service details and quote." };
    case "capacity_check":
      return { code: "finding_technician", label: "Finding the right technician", message: "We're checking technician availability for your appointment window." };
    case "scoring":
      return { code: "selecting_technician", label: "Selecting your technician", message: "We're matching you with the best available certified technician." };
    case "disruption_review":
      return { code: "adjusting_schedule", label: "We're adjusting your appointment", message: "We're fitting your visit into the schedule." };
    default:
      return { code: "request_received", label: "Request received", message: "We've received your request and are getting started." };
  }
}

function buildTimeline(job: Job, statusCode: string): PublicTimelineStep[] {
  const order = [
    "received",
    "understood",
    "selected",
    "en_route",
    "arrived",
    "completed",
  ] as const;

  const reachedIdx: Record<(typeof order)[number], boolean> = {
    received: true, // a job always exists once tracked
    understood: !["request_received"].includes(statusCode) || job.pipeline_stage !== "intake",
    selected: ["assigned", "en_route", "arrived", "completed"].includes(statusCode) ||
      ["assigned", "disruption_review", "done"].includes(job.pipeline_stage) ||
      job.status === "assigned" || job.status === "frozen" || job.status === "in_progress" || job.status === "completed",
    en_route: statusCode === "en_route" || statusCode === "arrived" || statusCode === "completed",
    arrived: statusCode === "arrived" || statusCode === "completed",
    completed: statusCode === "completed",
  };

  const labels: Record<(typeof order)[number], string> = {
    received: "Request received",
    understood: "Problem understood",
    selected: "Technician selected",
    en_route: "Technician en route",
    arrived: "Technician arrived",
    completed: "Job completed",
  };

  let currentAssigned = false;
  return order.map((key) => {
    const done = reachedIdx[key];
    let state: PublicTimelineStep["state"] = done ? "done" : "upcoming";
    if (!done && !currentAssigned) {
      state = "current";
      currentAssigned = true;
    }
    return { key, label: labels[key], state };
  });
}

/** Deterministic, customer-safe explanation for why this technician was
 *  picked — built from structured facts already on the job/technician
 *  (skills, certs, tier SLA), never from the raw scoring breakdown or
 *  candidate list. */
// Minimum evidence before the explanation claims "strong customer
// satisfaction" — matches the same "don't trust a tiny sample" principle
// as the Bayesian smoothing in rating.ts, just expressed as a plain
// threshold since this is prose, not a score.
const EXPLANATION_MIN_RATINGS = 5;
const EXPLANATION_STRONG_AVERAGE = 4.5;

function buildExplanation(
  job: Job,
  tech: Technician | null,
  ratingSummary?: TechnicianRatingSummary | null,
): string | null {
  if (!tech) return null;
  const skillNames = job.skill_required.map((s) => SKILL_LABEL[s]).join(", ");
  const tierLabel = TIER_META[job.tier].label.toLowerCase();
  let text =
    `${tech.name} was selected because they're qualified for ${skillNames || "your service"} ` +
    `and can reach you within your ${tierLabel} appointment window.`;
  if (
    ratingSummary &&
    ratingSummary.count >= EXPLANATION_MIN_RATINGS &&
    ratingSummary.average != null &&
    ratingSummary.average >= EXPLANATION_STRONG_AVERAGE
  ) {
    text += " They also have strong recent customer satisfaction.";
  }
  return text;
}

function buildDisruption(job: Job): PublicJobView["disruption"] {
  if (job.reschedule_history.length === 0) return null;
  const last = job.reschedule_history.at(-1)!;
  if (job.pipeline_stage === "awaiting_approval") {
    return {
      headline: "We're reviewing a schedule change",
      detail: "A coordinator is confirming an updated appointment time. Nothing further is needed from you.",
    };
  }
  return {
    headline: "Your appointment was adjusted",
    detail: `We moved your appointment to fit the schedule (${last.reason}). Your new time is shown above, and it stays within your original service window.`,
  };
}

export function toPublicJobView(
  job: Job,
  tech: Technician | null,
  ratingSummary?: TechnicianRatingSummary | null,
): PublicJobView {
  const { code, label, message } = deriveStatus(job);
  const { date, time } = sgDateParts(job.scheduled_time);
  const showTechnician = tech && ["assigned", "frozen", "in_progress", "completed"].includes(job.status);

  const etaMinutes =
    tech && ["assigned", "frozen", "in_progress"].includes(job.status)
      ? Math.max(0, Math.round(hoursBetween(nowISO(), job.scheduled_time) * 60))
      : null;

  return {
    trackingToken: job.public_tracking_token,
    trackingCode: job.public_tracking_token,
    status: code,
    statusLabel: label,
    message,
    appointment: {
      date,
      start: time,
      end: addMinutesLabel(job.scheduled_time, DEFAULT_VISIT_MIN),
    },
    service: {
      category: job.problem_category || "Aircon service",
      summary: job.problem_description.slice(0, 300),
    },
    technician: showTechnician && tech ? { name: tech.name, specialty: specialtyFor(tech) } : null,
    location: { lat: job.location.lat, lng: job.location.lng },
    technicianLocation: showTechnician && tech ? { lat: tech.location.lat, lng: tech.location.lng } : null,
    eta: etaMinutes,
    price: job.price,
    timeline: buildTimeline(job, code),
    explanation: showTechnician ? buildExplanation(job, tech, ratingSummary) : null,
    disruption: buildDisruption(job),
    feedbackEligible: job.status === "completed" && !!job.assigned_technician_id,
  };
}
