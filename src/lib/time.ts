/** Time helpers. All internal timestamps are ISO strings in UTC; the UI
 * renders them in Asia/Singapore. */

export const SG_TZ = "Asia/Singapore";

export function nowISO(): string {
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

/**
 * Snap a target instant to the next slot that lands inside the fleet's
 * common service hours (default 09:00–17:00 SGT), rounded to the hour.
 * Keeps `earliest` as a floor. Used by the orchestrator so the scoring
 * pass isn't handed a 3 a.m. appointment that every technician rejects.
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
