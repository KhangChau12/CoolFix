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
