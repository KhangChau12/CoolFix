// GET /api/public/jobs/:token — the customer tracking endpoint.
//
// This is the ONLY way a browser without any of our other API access can
// read a job: it requires the public tracking token (a bearer credential,
// never the job_id) and returns a sanitized, customer-safe projection —
// see `src/lib/publicTracking.ts` for exactly what is and isn't included.
//
// Security notes (CLAUDE.md-style, kept close to the code that enforces
// them):
//   - Lookup goes through `repo.getJobByTrackingToken`, which is the only
//     repo function that can resolve a token to a job. There is no code
//     path here that accepts a job_id instead.
//   - A malformed token and a well-formed-but-unknown token return the
//     exact same 404 body — never "invalid format" vs. "not found", so a
//     caller can't use the error to fish for valid-looking tokens.
//   - The response body is built by `toPublicJobView`, which is an
//     allow-list projection (only the fields it explicitly copies are
//     ever included) rather than a deny-list over the full `Job` /
//     `Technician` row — so a new internal column never leaks by default.

import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import * as repo from "@/lib/repo";
import { isValidTrackingTokenFormat } from "@/lib/trackingTokenFormat";
import { toPublicJobView } from "@/lib/publicTracking";
import { summarizeTechnicianFeedback } from "@/lib/rating";

export const dynamic = "force-dynamic";

const NOT_FOUND = {
  error: "Tracking code not found. Please check the code and try again.",
};

// In-memory, per-process enumeration throttle — single-node deployment
// (see next.config.mjs), so a module-level Map is enough; no new DB table
// needed (matches the existing pipelineChain in-process-lock philosophy
// elsewhere in this codebase). Keyed by a salted hash of the requester's IP
// (never the raw IP, same salt convention as the feedback rate limiter),
// tracking DISTINCT tokens queried in a rolling window: the customer's own
// tracking page polls the SAME token every few seconds forever and is never
// throttled by this — only querying many DIFFERENT tokens from one source
// (token-guessing) trips it.
const WINDOW_MS = 5 * 60_000;
const MAX_DISTINCT_TOKENS_PER_WINDOW = 20;
const recentQueriesByIp = new Map<string, { tokens: Set<string>; windowStart: number }>();

function rateLimitTrackingLookup(req: Request, token: string): boolean {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const salt = process.env.FEEDBACK_RATE_LIMIT_SALT ?? "coolfix-demo-rate-limit";
  const ipHash = createHash("sha256").update(`${salt}:tracking:${ip}`).digest("hex").slice(0, 32);
  const now = Date.now();
  let entry = recentQueriesByIp.get(ipHash);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    entry = { tokens: new Set(), windowStart: now };
    recentQueriesByIp.set(ipHash, entry);
  }
  entry.tokens.add(token);
  // Opportunistic cleanup so the map can't grow unbounded over a
  // long-running process.
  if (recentQueriesByIp.size > 5000) {
    for (const [k, v] of recentQueriesByIp) {
      if (now - v.windowStart > WINDOW_MS) recentQueriesByIp.delete(k);
    }
  }
  return entry.tokens.size <= MAX_DISTINCT_TOKENS_PER_WINDOW;
}

export async function GET(req: Request, { params }: { params: { token: string } }) {
  const token = params.token ?? "";

  if (!isValidTrackingTokenFormat(token)) {
    return NextResponse.json(NOT_FOUND, { status: 404 });
  }

  if (!rateLimitTrackingLookup(req, token)) {
    return NextResponse.json(
      { error: "Too many tracking lookups from this connection. Please try again in a few minutes." },
      { status: 429 },
    );
  }

  // Fail closed on any lookup error (not just "not found") — a customer
  // tracking link should never surface a raw DB/server error, and this is
  // also what keeps the endpoint safe to hit during the brief window before
  // migration 0005 is applied to a given environment.
  let job;
  try {
    job = await repo.getJobByTrackingToken(token);
  } catch (e) {
    console.error("[public/jobs] lookup failed", e instanceof Error ? e.message : e);
    return NextResponse.json(NOT_FOUND, { status: 404 });
  }
  if (!job) {
    return NextResponse.json(NOT_FOUND, { status: 404 });
  }

  const tech = job.assigned_technician_id
    ? await repo.getTechnician(job.assigned_technician_id)
    : null;
  const ratingSummary = job.assigned_technician_id
    ? summarizeTechnicianFeedback(
        job.assigned_technician_id,
        await repo.listFeedbackForTechnician(job.assigned_technician_id),
      )
    : null;

  return NextResponse.json(toPublicJobView(job, tech ?? null, ratingSummary));
}
