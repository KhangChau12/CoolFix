import { NextRequest, NextResponse } from "next/server";

const OSRM_BASE = process.env.OSRM_BASE_URL ?? "https://router.project-osrm.org";
const TRAFFIC_IMAGES_URL =
  process.env.DATA_GOV_TRAFFIC_IMAGES_URL ?? "https://api.data.gov.sg/v1/transport/traffic-images";

type LatLng = { lat: number; lng: number };
type LonLat = [number, number];
type TrafficSeverity = "low" | "medium" | "high";

interface TrafficCamera {
  camera_id: string;
  image: string;
  timestamp: string;
  lat: number;
  lng: number;
  /** Optional fields are accepted for an enriched traffic feed. The
   * data.gov.sg Traffic Images endpoint currently returns images/locations
   * only, so the normal response leaves these undefined. */
  severity?: TrafficSeverity;
  incident?: boolean;
}

interface OsrmRoute {
  distance: number;
  duration: number;
  geometry?: { coordinates?: LonLat[] };
}

interface OsrmResponse {
  code?: string;
  message?: string;
  routes?: OsrmRoute[];
}

interface TrafficResponse {
  items?: Array<{
    timestamp?: string;
    cameras?: Array<{
      camera_id?: string;
      image?: string;
      timestamp?: string;
      location?: { latitude?: number; longitude?: number };
      severity?: string | number;
      congestion?: string | number;
      traffic_status?: string | number;
      incident?: boolean;
    }>;
  }>;
}

interface CongestionSegment {
  coordinates: LonLat[];
  severity: TrafficSeverity;
}

function numberParam(value: string | null): number | null {
  if (value == null || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function validSingaporePoint(p: LatLng): boolean {
  return p.lat >= 1.15 && p.lat <= 1.5 && p.lng >= 103.55 && p.lng <= 104.1;
}

function haversineKm(a: LatLng, b: LatLng): number {
  const r = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

/** Approximate distance from a camera to a route polyline in kilometres. */
function distanceToRoute(camera: LatLng, route: LonLat[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < route.length; i++) {
    const a = { lat: route[i - 1][1], lng: route[i - 1][0] };
    const b = { lat: route[i][1], lng: route[i][0] };
    const meanLat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
    const x = (camera.lng - a.lng) * Math.cos(meanLat);
    const y = camera.lat - a.lat;
    const dx = (b.lng - a.lng) * Math.cos(meanLat);
    const dy = b.lat - a.lat;
    const denominator = dx * dx + dy * dy;
    const t = denominator === 0 ? 0 : Math.max(0, Math.min(1, (x * dx + y * dy) / denominator));
    const nearest = {
      lat: a.lat + (b.lat - a.lat) * t,
      lng: a.lng + (b.lng - a.lng) * t,
    };
    best = Math.min(best, haversineKm(camera, nearest));
  }
  return best;
}

function normalizeSeverity(value: unknown): TrafficSeverity | undefined {
  if (typeof value === "number") {
    if (value >= 0.75) return "high";
    if (value >= 0.4) return "medium";
    if (value >= 0) return "low";
  }
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (/high|severe|critical|red|heavy|standstill/.test(normalized)) return "high";
  if (/medium|moderate|orange|slow/.test(normalized)) return "medium";
  if (/low|light|yellow|free|normal/.test(normalized)) return "low";
  return undefined;
}

function severityRank(severity: TrafficSeverity): number {
  return severity === "high" ? 3 : severity === "medium" ? 2 : 1;
}

function highestSeverity(values: Array<TrafficSeverity | undefined>): TrafficSeverity | undefined {
  return values.filter((value): value is TrafficSeverity => Boolean(value)).sort((a, b) => severityRank(b) - severityRank(a))[0];
}

function buildCongestionSegments(route: LonLat[], cameras: TrafficCamera[]): CongestionSegment[] {
  const segments: CongestionSegment[] = [];
  let current: CongestionSegment | null = null;

  for (let i = 1; i < route.length; i++) {
    const pair: LonLat[] = [route[i - 1], route[i]];
    const severity = highestSeverity(
      cameras
        .filter((camera) => distanceToRoute(camera, pair) <= 0.35)
        // A camera close to the route is rendered as a conservative low
        // (yellow) observation until an enriched feed supplies a measured
        // medium/high severity. It never adds delay by itself.
        .map((camera) => camera.severity ?? "low"),
    );

    if (!severity) {
      if (current) segments.push(current);
      current = null;
      continue;
    }

    if (current && current.severity === severity) {
      current.coordinates.push(route[i]);
    } else {
      if (current) segments.push(current);
      current = { coordinates: [route[i - 1], route[i]], severity };
    }
  }
  if (current) segments.push(current);
  return segments;
}

async function getTrafficCameras(): Promise<TrafficCamera[]> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (process.env.DATA_GOV_SG_API_KEY) headers["x-api-key"] = process.env.DATA_GOV_SG_API_KEY;

  const response = await fetch(TRAFFIC_IMAGES_URL, {
    headers,
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Traffic Images returned ${response.status}`);

  const payload = (await response.json()) as TrafficResponse;
  const item = payload.items?.[0];
  return (item?.cameras ?? []).flatMap((camera) => {
    const lat = camera.location?.latitude;
    const lng = camera.location?.longitude;
    if (
      !camera.camera_id ||
      !camera.image ||
      lat == null ||
      lng == null ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng)
    ) {
      return [];
    }
    return [
      {
        camera_id: camera.camera_id,
        image: camera.image,
        timestamp: camera.timestamp ?? item?.timestamp ?? "",
        lat,
        lng,
        severity: normalizeSeverity(camera.severity ?? camera.congestion ?? camera.traffic_status),
        incident: camera.incident === true,
      },
    ];
  });
}

export async function GET(request: NextRequest) {
  const search = request.nextUrl.searchParams;
  const from = {
    lat: numberParam(search.get("fromLat")),
    lng: numberParam(search.get("fromLng")),
  };
  const to = {
    lat: numberParam(search.get("toLat")),
    lng: numberParam(search.get("toLng")),
  };

  if (
    from.lat == null ||
    from.lng == null ||
    to.lat == null ||
    to.lng == null ||
    !validSingaporePoint(from as LatLng) ||
    !validSingaporePoint(to as LatLng)
  ) {
    return NextResponse.json({ error: "Valid Singapore origin and destination are required." }, { status: 400 });
  }

  const coordinates = `${from.lng},${from.lat};${to.lng},${to.lat}`;
  const routeUrl =
    `${OSRM_BASE.replace(/\/$/, "")}/route/v1/driving/${coordinates}` +
    "?alternatives=true&overview=full&geometries=geojson&steps=true";

  try {
    const [osrmResponse, trafficResult] = await Promise.allSettled([
      fetch(routeUrl, { cache: "no-store" }),
      getTrafficCameras(),
    ]);

    if (osrmResponse.status === "rejected" || !osrmResponse.value.ok) {
      const status = osrmResponse.status === "fulfilled" ? osrmResponse.value.status : 502;
      throw new Error(`OSRM route request failed (${status}).`);
    }

    const osrm = (await osrmResponse.value.json()) as OsrmResponse;
    if (osrm.code !== "Ok" || !osrm.routes?.length) {
      throw new Error(osrm.message ?? "OSRM could not find a driving route.");
    }

    const cameras = trafficResult.status === "fulfilled" ? trafficResult.value : [];
    const trafficAvailable = trafficResult.status === "fulfilled";
    const routes = osrm.routes.slice(0, 3).map((route, index) => {
      const geometry = route.geometry?.coordinates ?? [];
      const nearbyCameras = cameras.filter(
        (camera) => geometry.length > 1 && distanceToRoute(camera, geometry) <= 1.5,
      );

      // Traffic Images provides fresh camera images and coordinates, but not
      // machine-readable speeds or incident records. Keep the formula
      // explicit and conservative instead of inventing a delay from camera
      // count; the camera evidence is exposed to the technician on the map.
      const routeCameras = nearbyCameras;
      const congestionSegments = buildCongestionSegments(geometry, routeCameras);
      const congestionDelay = routeCameras.reduce((total, camera) => {
        if (camera.severity === "high") return total + 180;
        if (camera.severity === "medium") return total + 90;
        return total + (camera.severity === "low" ? 30 : 0);
      }, 0);
      const incidentPenalty = routeCameras.filter((camera) => camera.incident).length * 300;
      const adjustedTime = route.duration + congestionDelay + incidentPenalty;

      return {
        id: `route-${index + 1}`,
        distance: route.distance,
        normalTime: route.duration,
        congestionDelay,
        incidentPenalty,
        adjustedTime,
        geometry,
        nearbyCameraIds: nearbyCameras.map((camera) => camera.camera_id),
        congestionSegments,
      };
    });

    routes.sort((a, b) => a.adjustedTime - b.adjustedTime || a.distance - b.distance);

    const recommendedCameraIds = new Set(routes[0]?.nearbyCameraIds ?? []);
    const routeCameras = cameras.filter((camera) => recommendedCameraIds.has(camera.camera_id));

    return NextResponse.json({
      origin: from,
      destination: to,
      recommended: routes[0],
      routes,
      // Never expose unrelated camera observations to the technician's map.
      cameras: routeCameras,
      trafficAvailable,
      trafficObservedAt: routeCameras[0]?.timestamp ?? null,
      trafficNote: trafficAvailable
        ? "Only traffic observations close to the recommended route are shown. Camera-only observations are marked low/yellow; enriched medium/orange and high/red values are used when available. The Traffic Images API itself does not publish speed or incident fields."
        : "Traffic Images is temporarily unavailable; the recommendation uses OSRM time only.",
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to calculate a route." },
      { status: 502 },
    );
  }
}
