// ── Technician rating math ──────────────────────────────────────────
// Pure functions over `JobFeedback[]` — no DB, no framework. Two distinct
// numbers come out of here, and the rest of the app must not confuse them:
//
//   average   — the plain arithmetic mean. CUSTOMER-FACING ("4.8 / 5,
//               127 ratings"). Never used for scheduling: a technician's
//               very first review would otherwise swing it to a full 1.0
//               or 5.0 with n=1, which is not a signal, it's noise.
//
//   smoothed  — a Bayesian/minimum-sample estimate that pulls a
//               low-volume average back toward a neutral prior, more so
//               the fewer ratings exist. SCHEDULING-FACING (feeds
//               `customerSatisfaction` in scoring.ts). At n=0 it equals
//               the prior exactly — a brand-new technician is treated as
//               "presumed competent", never penalised to 0.
//
//       smoothed = (n / (n + PRIOR_WEIGHT)) * average
//                + (PRIOR_WEIGHT / (n + PRIOR_WEIGHT)) * PRIOR_MEAN
//
// PRIOR_MEAN / PRIOR_WEIGHT are the two tunable constants:
//   PRIOR_MEAN   = 4.3 — service-rating platforms skew high in general
//                  (most visits go fine); treating a total unknown as
//                  "probably fine" is a better prior than a flat 3.0.
//   PRIOR_WEIGHT = 8   — read as "8 imaginary average reviews" of
//                  evidence a technician's own ratings must outweigh
//                  before they swing the smoothed score much. A single
//                  5-star (or 1-star) review moves smoothed by only
//                  ~1/9th of the gap to that rating; by ~20 real ratings
//                  the prior's influence has faded to a minor nudge.

import type { FeedbackImprovementTag, FeedbackPositiveTag, JobFeedback } from "./types";

export const RATING_PRIOR_MEAN = 4.3;
export const RATING_PRIOR_WEIGHT = 8;

/** How many of a technician's most recent ratings count as "recent" when
 *  judging a trend, and the minimum total before a trend is claimed at
 *  all (fewer than this and any wobble is noise, not a trend). */
const TREND_RECENT_N = 5;
const TREND_MIN_TOTAL = 6;
/** Minimum average-rating gap (recent vs. the rest) to call it a trend
 *  rather than noise. */
const TREND_THRESHOLD = 0.3;

export interface TechnicianRatingSummary {
  technician_id: string;
  count: number;
  /** Plain average, customer-facing. Null when there's nothing to average —
   *  render "Not enough ratings", never a misleading "0.0 ★". */
  average: number | null;
  /** Bayesian-smoothed estimate in [1,5], scheduling-facing. Always
   *  defined — see header. */
  smoothed: number;
  distribution: Record<1 | 2 | 3 | 4 | 5, number>;
  /** Tag → how many ratings mentioned it, sorted desc by count is the
   *  caller's job (kept as a plain record here so it composes). */
  positiveTagCounts: Partial<Record<FeedbackPositiveTag, number>>;
  improvementTagCounts: Partial<Record<FeedbackImprovementTag, number>>;
  /** "up"/"down" only when there's enough history to say so with any
   *  confidence; otherwise null (never invent a trend from 2 data points). */
  trend: "up" | "down" | "flat" | null;
}

/** The [0,1] scheduling signal `scoring.ts` reads — a linear map of the
 *  smoothed [1,5] rating, so 1★ → 0, 5★ → 1, and the cold-start prior
 *  (4.3) lands at 0.825 (a solid-but-not-perfect default: good enough to
 *  never penalise a new hire, not so high it beats a proven 5★ veteran). */
export function satisfactionScore01(smoothed: number): number {
  return Math.min(1, Math.max(0, (smoothed - 1) / 4));
}

export function smoothedRating(average: number | null, count: number): number {
  if (count <= 0 || average == null) return RATING_PRIOR_MEAN;
  const w = RATING_PRIOR_WEIGHT;
  return (count / (count + w)) * average + (w / (count + w)) * RATING_PRIOR_MEAN;
}

function emptyDistribution(): Record<1 | 2 | 3 | 4 | 5, number> {
  return { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
}

/** Build one technician's summary from just their own feedback rows (any
 *  order). Used both standalone (one technician's profile) and as the
 *  per-technician building block of `summarizeFeedbackByTechnician`. */
export function summarizeTechnicianFeedback(
  technicianId: string,
  rows: JobFeedback[],
): TechnicianRatingSummary {
  const distribution = emptyDistribution();
  const positiveTagCounts: Partial<Record<FeedbackPositiveTag, number>> = {};
  const improvementTagCounts: Partial<Record<FeedbackImprovementTag, number>> = {};
  let sum = 0;

  for (const r of rows) {
    const bucket = clampRating(r.rating) as 1 | 2 | 3 | 4 | 5;
    distribution[bucket] += 1;
    sum += bucket;
    for (const t of r.positive_tags) positiveTagCounts[t] = (positiveTagCounts[t] ?? 0) + 1;
    for (const t of r.improvement_tags) improvementTagCounts[t] = (improvementTagCounts[t] ?? 0) + 1;
  }

  const count = rows.length;
  const average = count > 0 ? sum / count : null;

  let trend: TechnicianRatingSummary["trend"] = null;
  if (count >= TREND_MIN_TOTAL) {
    const sorted = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at));
    const recent = sorted.slice(0, TREND_RECENT_N);
    const older = sorted.slice(TREND_RECENT_N);
    if (older.length > 0) {
      const recentAvg = recent.reduce((s, r) => s + r.rating, 0) / recent.length;
      const olderAvg = older.reduce((s, r) => s + r.rating, 0) / older.length;
      const delta = recentAvg - olderAvg;
      trend = delta >= TREND_THRESHOLD ? "up" : delta <= -TREND_THRESHOLD ? "down" : "flat";
    }
  }

  return {
    technician_id: technicianId,
    count,
    average,
    smoothed: smoothedRating(average, count),
    distribution,
    positiveTagCounts,
    improvementTagCounts,
    trend,
  };
}

/** Group a flat feedback list by technician and summarize each. Technicians
 *  with zero feedback are NOT included — callers should treat a missing
 *  entry as "0 ratings" (`summarizeTechnicianFeedback(id, [])`), which is
 *  exactly what the cold-start path needs anyway. */
export function summarizeFeedbackByTechnician(
  rows: JobFeedback[],
): Map<string, TechnicianRatingSummary> {
  const byTech = new Map<string, JobFeedback[]>();
  for (const r of rows) {
    const arr = byTech.get(r.technician_id) ?? [];
    arr.push(r);
    byTech.set(r.technician_id, arr);
  }
  const out = new Map<string, TechnicianRatingSummary>();
  for (const [techId, techRows] of byTech) {
    out.set(techId, summarizeTechnicianFeedback(techId, techRows));
  }
  return out;
}

/** The zero-ratings summary, for a technician with no feedback at all —
 *  `smoothed` is exactly the prior, `average` is null ("Not enough
 *  ratings"), never a misleading 0. */
export function emptyRatingSummary(technicianId: string): TechnicianRatingSummary {
  return summarizeTechnicianFeedback(technicianId, []);
}

function clampRating(n: number): number {
  return Math.min(5, Math.max(1, Math.round(n)));
}

/** Top N tags by count, descending, ties broken by the fixed vocabulary
 *  order (deterministic — never depends on object key insertion order). */
export function topTags<T extends string>(
  counts: Partial<Record<T, number>>,
  vocabulary: readonly T[],
  n = 3,
): { tag: T; count: number }[] {
  return vocabulary
    .map((tag) => ({ tag, count: counts[tag] ?? 0 }))
    .filter((t) => t.count > 0)
    .sort((a, b) => b.count - a.count || vocabulary.indexOf(a.tag) - vocabulary.indexOf(b.tag))
    .slice(0, n);
}
