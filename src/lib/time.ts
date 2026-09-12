/** Time helpers. All internal timestamps are ISO strings in UTC; the UI
 * renders them in Asia/Singapore. */

import type { Job } from "./types";

export const SG_TZ = "Asia/Singapore";

const CLOCK_STORAGE_KEY = "coolfix-runtime-clock";
type ClockMode = "real" | "custom";

let serverClockMode: ClockMode = "real";
let serverCustomTimeISO: string | null = null;

/** Apply the persisted demo clock in either the server process or browser. */
export function configureClock(config: { clockMode: ClockMode; customTimeISO: string | null }): void {
  serverClockMode = config.clockMode;
  serverCustomTimeISO = config.clockMode === "custom" ? config.customTimeISO : null;
}

function browserClock(): { clockMode: ClockMode; customTimeISO: string | null } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CLOCK_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<{ clockMode: ClockMode; customTimeISO: string | null }>;
    if (parsed.clockMode !== "custom" && parsed.clockMode !== "real") return null;
    return {
      clockMode: parsed.clockMode,
      customTimeISO: typeof parsed.customTimeISO === "string" ? parsed.customTimeISO : null,
    };
  } catch {
    return null;
  }
}

export function nowISO(): string {
  const browser = browserClock();
  const mode = browser?.clockMode ?? serverClockMode;
  const customTime = browser?.customTimeISO ?? serverCustomTimeISO;
  if (mode === "custom" && customTime && Number.isFinite(new Date(customTime).getTime())) {
    return customTime;
  }
  return new Date().toISOString();
}

export function addHours(iso: string, hours: number): string {
  return new Date(new Date(iso).getTime() + hours * 3600_000).toISOString();
}

export function hoursBetween(aISO: string, bISO: string): number {
  return (new Date(bISO).getTime() - new Date(aISO).getTime()) / 3600_000;
}

export function computeFreezePoint(scheduledISO: string, windowHours: number): string {
  return addHours(scheduledISO, -windowHours);
}

/** Is `now` past the job's freeze point? */
export function isFrozen(freezePointISO: string, nowISOStr = nowISO()): boolean {
  return new Date(nowISOStr).getTime() >= new Date(freezePointISO).getTime();
}

export function fmtSGDateTime(iso: string): string {
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: SG_TZ,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

export function fmtSGTime(iso: string): string {
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: SG_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

/** Singapore-local hour-of-day (0-23) for an instant. */
export function sgHour(iso: string): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: SG_TZ,
      hour: "2-digit",
      hour12: false,
    }).format(new Date(iso)),
  );
}

/** Singapore-local calendar day key ("YYYY-MM-DD") for an instant. Used to
 *  group a technician's jobs into "today" for the scoring pass. */
export function sgDayKey(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SG_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/** Do two instants fall on the same Singapore-local calendar day? */
export function sameSgDay(aISO: string, bISO: string): boolean {
  return sgDayKey(aISO) === sgDayKey(bISO);
}

/**
 * The wider window the disruption / edge-case slot search may place a job
 * in. It is deliberately larger than the customer-facing default
 * (09:00–17:00): the true hard limit on a technician's day is their own
 * `working_hours` (enforced by `isWithinWorkingHours`), not this snap. If
 * the search window is left at 09:00–17:00 the set of legal same-day
 * re-plan slots collapses to nothing whenever the demo runs mid-afternoon,
 * which is a run-time artefact, not a real constraint. 08:00–20:00 keeps a
 * real amount of same-day room while still rejecting a 3 a.m. slot.
 */
export const DISPATCH_SERVICE_HOURS = { open: 8, close: 20 } as const;

/**
 * Snap a target instant to the next slot that lands inside the fleet's
 * common service hours (default 09:00–17:00 SGT), rounded to the hour.
 * Keeps `earliest` as a floor. Used by the orchestrator so the scoring
 * pass isn't handed a 3 a.m. appointment that every technician rejects.
 * The disruption / edge-case slot search passes `DISPATCH_SERVICE_HOURS`
 * for a wider window (see that constant).
 */
export function snapToServiceHours(
  fromISO: string,
  earliestHoursOut: number,
  opts: { open?: number; close?: number } = {},
): string {
  const open = opts.open ?? 9;
  const close = opts.close ?? 17;
  let t = new Date(new Date(fromISO).getTime() + earliestHoursOut * 3600_000);
  // Round up to the next whole hour.
  if (t.getMinutes() !== 0 || t.getSeconds() !== 0 || t.getMilliseconds() !== 0) {
    t = new Date(Math.ceil(t.getTime() / 3600_000) * 3600_000);
  }
  for (let i = 0; i < 96; i++) {
    const h = sgHour(t.toISOString());
    if (h >= open && h < close) return t.toISOString();
    t = new Date(t.getTime() + 3600_000);
  }
  return t.toISOString();
}

/**
 * The latest SGT hour an urgent booking may be scheduled to *start* the
 * same day. If `now + earliestHoursOut` would land later than this, the job
 * rolls to the next day's dispatch open instead. This is what guarantees
 * that a job which gets bumped by an urgent booking always has a same-day
 * afternoon slot to be re-planned into — the whole "low impact → the agent
 * auto-commits" story depends on that headroom existing regardless of what
 * time of day the pipeline runs.
 */
export const URGENT_LATEST_SAME_DAY_HOUR = 14;

/**
 * Snap `now + earliestHoursOut` to a slot inside `windowHours`, but never
 * later than `latestSameDayHour` — a later target wraps to the next day's
 * open instead of landing right before close. Deterministic given the
 * instant. This is the shared rollover behaviour behind
 * `snapToUrgentDispatchSlot` below; factored out so any tier's scheduling
 * can opt into the same "always leaves same-day headroom" guarantee instead
 * of drifting out of sync with each other depending on wall-clock time.
 */
function snapWithRollover(
  fromISO: string,
  earliestHoursOut: number,
  windowHours: { open: number; close: number },
  latestSameDayHour: number,
): string {
  const snapped = snapToServiceHours(fromISO, earliestHoursOut, windowHours);
  if (sgHour(snapped) <= latestSameDayHour) return snapped;
  // Too late for a comfortable same-day window → next day, open.
  let t = new Date(snapped);
  for (let i = 0; i < 48; i++) {
    t = new Date(t.getTime() + 3600_000);
    const h = sgHour(t.toISOString());
    if (h === windowHours.open) return t.toISOString();
  }
  return snapped;
}

/**
 * Snap `now + earliestHoursOut` to an urgent-dispatch slot: inside
 * `DISPATCH_SERVICE_HOURS`, but never later than `URGENT_LATEST_SAME_DAY_HOUR`
 * — a later target wraps to the next day's open. Deterministic given the
 * instant. Used by the orchestrator (urgent bookings) and mirrored by the
 * seed so a seeded soft job sits exactly where the incoming urgent job lands.
 */
export function snapToUrgentDispatchSlot(
  fromISO: string,
  earliestHoursOut: number,
): string {
  return snapWithRollover(fromISO, earliestHoursOut, DISPATCH_SERVICE_HOURS, URGENT_LATEST_SAME_DAY_HOUR);
}

/**
 * The latest SGT hour a non-urgent (standard/priority/flexible) booking may
 * be scheduled to *start* the same day, before rolling to tomorrow's open.
 * Set lower than `URGENT_LATEST_SAME_DAY_HOUR` on purpose: non-urgent jobs
 * have days/weeks of slack, so there's no reason to ever hand one a
 * last-hour-of-the-day slot. Existing without this, a non-urgent booking's
 * scheduled slot could drift onto a different day than a same-instant
 * urgent/seeded job depending on exactly what hour the pipeline runs at —
 * a demo-breaking, purely run-time artefact (see `goldenEdgecaseWiden`).
 */
export const STANDARD_LATEST_SAME_DAY_HOUR = 15;

/**
 * Snap `now + earliestHoursOut` to a non-urgent dispatch slot: same wide
 * `DISPATCH_SERVICE_HOURS` window as urgent bookings (the real hard limit is
 * each technician's own `working_hours`, not this snap — see that constant's
 * doc comment), with its own same-day rollover cutoff. Used by the
 * orchestrator for every tier except urgent.
 */
export function snapToStandardDispatchSlot(
  fromISO: string,
  earliestHoursOut: number,
): string {
  return snapWithRollover(fromISO, earliestHoursOut, DISPATCH_SERVICE_HOURS, STANDARD_LATEST_SAME_DAY_HOUR);
}

/**
 * Does `technicianId` already have a job within ±90 min of `scheduledISO`?
 * Ignores `ignoreJobId` (the job being moved/scored itself) and jobs that
 * are completed or already disrupted. Single source of truth for the
 * no-double-booking hard constraint — shared by the Assignment Agent and
 * the Disruption Agent's candidate search / re-validation so the rule is
 * never re-derived differently in two places.
 */
export function findTimeClash(
  jobs: Job[],
  technicianId: string,
  scheduledISO: string,
  ignoreJobId: string,
): string | null {
  const clash = jobs.find(
    (j) =>
      j.job_id !== ignoreJobId &&
      j.assigned_technician_id === technicianId &&
      j.status !== "completed" &&
      j.status !== "disrupted" &&
      Math.abs(hoursBetween(j.scheduled_time, scheduledISO)) < 1.5,
  );
  return clash ? clash.job_id : null;
}

/**
 * Is `scheduledISO` (in SGT local time) within `workingHours` ("HH:mm"
 * start/end, inclusive)? Single source of truth — shared by the
 * Technician-State Agent (pre-computes it per candidate) and the
 * Disruption Agent's candidate search / re-validation.
 */
export function isWithinWorkingHours(
  workingHours: { start: string; end: string },
  scheduledISO: string,
): boolean {
  const local = new Intl.DateTimeFormat("en-GB", {
    timeZone: SG_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(scheduledISO));
  const [h, m] = local.split(":").map(Number);
  const mins = h * 60 + m;
  const [sh, sm] = workingHours.start.split(":").map(Number);
  const [eh, em] = workingHours.end.split(":").map(Number);
  return mins >= sh * 60 + sm && mins <= eh * 60 + em;
}
