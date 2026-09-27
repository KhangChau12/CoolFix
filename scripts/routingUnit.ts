import assert from "node:assert/strict";
import { NextRequest } from "next/server";

// All provider responses are local fixtures: this test never contacts the
// traffic provider, routing service, or database.
async function main() {
  const demo = process.argv.includes("--demo");
  process.env.DEMO_TRAFFIC = String(demo);
  const { GET } = await import("../src/app/api/routing/recommendation/route");
  const originalFetch = globalThis.fetch;
  const geometry = Array.from({ length: 24 }, (_, index) => [103.7 + index * 0.004, 1.32] as [number, number]);
  let severity: string | undefined;
  let trafficFails = false;
  let routeFails = false;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/route/v1/")) {
      if (routeFails) return new Response("Unavailable", { status: 503 });
      return Response.json({ code: "Ok", routes: [{
        distance: 13000, duration: 1200, geometry: { coordinates: geometry },
        legs: [
          { duration: 500, steps: [{ geometry: { coordinates: geometry.slice(0, 12) } }] },
          { duration: 700, steps: [{ geometry: { coordinates: geometry.slice(11) } }] },
        ],
      }] });
    }
    if (trafficFails) throw new Error("Traffic feed unavailable");
    return Response.json({ items: [{ timestamp: "2026-09-24T09:00:00+08:00", cameras: [{
      camera_id: "test-camera", image: "https://example.invalid/traffic.jpg",
      location: { longitude: geometry[4][0], latitude: geometry[4][1] }, severity,
    }] }] });
  };
  const request = () => new NextRequest("http://localhost/api/routing/recommendation?points=103.7,1.32;103.744,1.32;103.792,1.32");
  try {
    const result = await GET(request());
    assert.equal(result.status, 200);
    const payload = await result.json();
    assert.equal(payload.simulatedTraffic, demo);
    assert.equal(payload.recommended.legs.length, 2);
    if (demo) {
      assert.match(payload.trafficNote, /simulated.*not live/i);
      assert.ok(payload.recommended.congestionSegments.length > 0);
      assert.ok(payload.recommended.adjustedLegDurations[0] > 500);
      for (const segment of payload.recommended.congestionSegments) {
        assert.ok(segment.coordinates.every((point: number[]) => geometry.some((road) => road[0] === point[0] && road[1] === point[1])));
      }
    } else {
      assert.equal(payload.recommended.congestionSegments.length, 0, "Camera proximity alone must not imply congestion");
      assert.equal(payload.recommended.adjustedTime, 1200);
      assert.equal(payload.recommended.adjustedLegDurations[0], 500);
      severity = "high";
      const enriched = await (await GET(request())).json();
      assert.ok(enriched.recommended.congestionSegments.length > 0);
      assert.ok(enriched.recommended.adjustedLegDurations[0] > 500, "First-stop ETA must include reported traffic delay");
    }
    trafficFails = true;
    const fallback = await GET(request());
    assert.equal(fallback.status, 200, "Traffic outage must not hide a valid road route");
    assert.equal((await fallback.json()).trafficAvailable, false);
    const invalid = await GET(new NextRequest("http://localhost/api/routing/recommendation?points=103.7,1.32;0,0;103.8,1.32"));
    assert.equal(invalid.status, 400);
    routeFails = true;
    assert.equal((await GET(request())).status, 502);
    console.log(`Routing regression checks passed (${demo ? "simulated" : "provider"} traffic).`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
