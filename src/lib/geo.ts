import type { GeoPoint } from "./types";

/**
 * Haversine great-circle distance in km. Good enough for Singapore-scale
 * routing heuristics in the scoring formula (no external maps API — keeps
 * the demo offline-safe and avoids per-call cost).
 */
export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 100) / 100;
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** A few Singapore anchor points for the seed data. */
export const SG_LANDMARKS = {
  cityHall: { lat: 1.2931, lng: 103.8520 },
  jurongEast: { lat: 1.3329, lng: 103.7436 },
  tampines: { lat: 1.3496, lng: 103.9568 },
  woodlands: { lat: 1.4382, lng: 103.7890 },
  bishan: { lat: 1.3526, lng: 103.8352 },
  buonaVista: { lat: 1.3068, lng: 103.7900 },
  changi: { lat: 1.3644, lng: 103.9915 },
  clementi: { lat: 1.3162, lng: 103.7649 },
} as const;

/**
 * Mainland Singapore + immediate islands, with a small margin. A booking
 * whose geocoded coordinate falls outside this box is rejected at the
 * schema boundary (`validateBookingRequest`) — the fleet only serves SG,
 * and it stops a malformed / injected coordinate from reaching the
 * scoring formula. Also used client-side by the address picker to keep a
 * dropped pin inside the service area.
 */
export const SG_BOUNDS = {
  minLat: 1.15,
  maxLat: 1.48,
  minLng: 103.6,
  maxLng: 104.1,
} as const;

/** Geographic centre of Singapore — the map picker's initial view. */
export const SG_CENTER = { lat: 1.3521, lng: 103.8198 } as const;

export function isWithinSG(p: { lat: number; lng: number }): boolean {
  return (
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    p.lat >= SG_BOUNDS.minLat &&
    p.lat <= SG_BOUNDS.maxLat &&
    p.lng >= SG_BOUNDS.minLng &&
    p.lng <= SG_BOUNDS.maxLng
  );
}

/** Clamp a coordinate into the SG service box (used when a pin is dragged
 * just past the edge — snap it back rather than reject outright). */
export function clampToSG(p: { lat: number; lng: number }): { lat: number; lng: number } {
  return {
    lat: Math.min(Math.max(p.lat, SG_BOUNDS.minLat), SG_BOUNDS.maxLat),
    lng: Math.min(Math.max(p.lng, SG_BOUNDS.minLng), SG_BOUNDS.maxLng),
  };
}
