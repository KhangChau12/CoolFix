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
import * as repo from "@/lib/repo";
import { isValidTrackingTokenFormat } from "@/lib/trackingTokenFormat";
import { toPublicJobView } from "@/lib/publicTracking";

export const dynamic = "force-dynamic";

const NOT_FOUND = {
  error: "Tracking code not found. Please check the code and try again.",
};

export async function GET(_req: Request, { params }: { params: { token: string } }) {
  const token = params.token ?? "";

  if (!isValidTrackingTokenFormat(token)) {
    return NextResponse.json(NOT_FOUND, { status: 404 });
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

  return NextResponse.json(toPublicJobView(job, tech ?? null));
}
