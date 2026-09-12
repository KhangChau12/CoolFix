"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiSend } from "@/lib/client";
import MapView, { type TrafficCamera } from "@/components/MapView";
import type { Job, Technician } from "@/lib/types";

interface RouteOption {
  id: string;
  distance: number;
  normalTime: number;
  congestionDelay: number;
  incidentPenalty: number;
  adjustedTime: number;
  geometry: Array<[number, number]>;
  nearbyCameraIds: string[];
  congestionSegments: Array<{
    coordinates: Array<[number, number]>;
    severity: "low" | "medium" | "high";
  }>;
}

interface Recommendation {
  recommended: RouteOption;
  routes: RouteOption[];
  cameras: TrafficCamera[];
  trafficAvailable: boolean;
  trafficObservedAt: string | null;
  trafficNote: string;
}

export default function RecommendedRouting({
  tech,
  currentJob,
}: {
  tech: Technician | undefined;
  currentJob: Job | null;
}) {
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [routeChangeNotice, setRouteChangeNotice] = useState<string | null>(null);
  const [pendingRecommendation, setPendingRecommendation] = useState<Recommendation | null>(null);
  const notifyingSignature = useRef<string | null>(null);
  const activeSignature = useRef<string | null>(null);
  const recommendationRef = useRef<Recommendation | null>(null);

  const refresh = useCallback(async (deferChangedRoute = false) => {
    if (!tech || !currentJob) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        fromLat: String(tech.location.lat),
        fromLng: String(tech.location.lng),
        toLat: String(currentJob.location.lat),
        toLng: String(currentJob.location.lng),
      });
      const result = await apiGet<Recommendation>(`/api/routing/recommendation?${params}`);
      const signature = routeSignature(result.recommended);
      const storageKey = `coolfix-route-signature:${tech.technician_id}:${currentJob.job_id}`;
      let previousSignature: string | null = null;
      try {
        previousSignature = window.sessionStorage.getItem(storageKey);
        window.sessionStorage.setItem(storageKey, signature);
      } catch {
        // Session storage is only a duplicate-notification guard; routing
        // remains usable when browser storage is blocked.
      }

      if (
        previousSignature &&
        previousSignature !== signature &&
        notifyingSignature.current !== signature
      ) {
        notifyingSignature.current = signature;
        const routeLabel = `${currentJob.customer_name} · ${currentJob.location.address}`;
        try {
          await apiSend("/api/notifications", "POST", {
            notification_id: `ntf_route_${hashString(`${tech.technician_id}:${currentJob.job_id}:${signature}`)}`,
            channel: "technician_app",
            recipient_id: tech.technician_id,
            job_id: currentJob.job_id,
            kind: "route_change_request",
            subject: "Route update needs your approval",
            body: `The recommended route to ${routeLabel} changed after a traffic refresh. Please review the new route and approve the change before updating navigation.`,
          });
          setRouteChangeNotice("Route updated — a permission request was sent to your Messages inbox.");
        } catch {
          setRouteChangeNotice("Route updated — review the new route before changing navigation.");
        }
      }

      const routeChanged = Boolean(
        activeSignature.current && activeSignature.current !== signature,
      );
      if (deferChangedRoute && recommendationRef.current && routeChanged) {
        // A manual check must not move the active route immediately. Hold the
        // new recommendation until the technician explicitly reviews it.
        setPendingRecommendation(result);
      } else {
        recommendationRef.current = result;
        activeSignature.current = signature;
        setRecommendation(result);
        setPendingRecommendation(null);
        setUpdatedAt(new Date());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to calculate a route.");
    } finally {
      setLoading(false);
    }
  }, [currentJob, tech]);

  useEffect(() => {
    setRecommendation(null);
    setRouteChangeNotice(null);
    setPendingRecommendation(null);
    activeSignature.current = null;
    recommendationRef.current = null;
    notifyingSignature.current = null;
    // Routing is checked when this screen/task changes. It is never polled
    // automatically for new OSRM or traffic results.
    void refresh(false);
  }, [refresh]);

  function applyPendingRecommendation() {
    if (!pendingRecommendation) return;
    const signature = routeSignature(pendingRecommendation.recommended);
    recommendationRef.current = pendingRecommendation;
    activeSignature.current = signature;
    setRecommendation(pendingRecommendation);
    setPendingRecommendation(null);
    setUpdatedAt(new Date());
    setRouteChangeNotice("Route update applied. Navigation can now be changed.");
  }

  if (!tech) {
    return <div style={{ padding: 24 }} className="muted">Loading technician position…</div>;
  }

  if (!currentJob) {
    return (
      <div style={{ padding: 24 }}>
        <h2 style={{ fontSize: 18 }}>Recommended routing</h2>
        <p className="muted" style={{ fontSize: 13 }}>There are no active or upcoming jobs to route to.</p>
      </div>
    );
  }

  const route = recommendation?.recommended;
  const routeCoordinates = route?.geometry.map(([lng, lat]) => [lat, lng] as [number, number]);

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <div className="spread" style={{ gap: 8 }}>
          <div>
            <h2 style={{ fontSize: 18 }}>Recommended routing</h2>
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>
              From {tech.name}&rsquo;s current position to {currentJob.customer_name}&rsquo;s service stop.
            </p>
          </div>
          <button
            className={`btn${pendingRecommendation ? " routing-update-button" : ""}`}
            style={{ fontSize: 11.5, padding: "6px 9px" }}
            onClick={() => (pendingRecommendation ? applyPendingRecommendation() : void refresh(true))}
            disabled={loading}
          >
            {loading ? "Checking…" : pendingRecommendation ? "Review route update" : "Check for updates"}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ padding: 11, borderRadius: 8, color: "var(--danger-strong)", background: "var(--tier-urgent-bg)", border: "1px solid var(--tier-urgent)" }}>
          {error}
        </div>
      )}

      {route && routeCoordinates && routeCoordinates.length > 1 && currentJob && (
        <>
          <MapView
            mode="display"
            height={270}
            interactiveZoom
            customer={{ ...currentJob.location }}
            technician={{ ...tech.location, name: tech.name }}
            route={{
              coordinates: routeCoordinates,
              color: "var(--brand)",
              congestionSegments: route.congestionSegments.map((segment) => ({
                coordinates: segment.coordinates.map(([lng, lat]) => [lat, lng] as [number, number]),
                severity: segment.severity,
              })),
            }}
            trafficCameras={recommendation?.cameras ?? []}
          />

          {routeChangeNotice && (
            <div style={{ padding: 11, borderRadius: 8, color: "var(--brand-ink)", background: "var(--brand-tint)", border: "1px solid var(--brand)" }}>
              {routeChangeNotice}
            </div>
          )}

          <div className="card" style={{ padding: 13 }}>
            <div className="spread" style={{ alignItems: "baseline", gap: 8 }}>
              <strong style={{ fontSize: 14 }}>Best current route</strong>
              <span className="mono" style={{ color: "var(--brand-ink)", fontWeight: 700 }}>{formatDuration(route.adjustedTime)}</span>
            </div>
            <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
              {formatDistance(route.distance)} · {route.nearbyCameraIds.length} nearby traffic camera{route.nearbyCameraIds.length === 1 ? "" : "s"}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "5px 12px", marginTop: 12, fontSize: 11.5 }}>
              <span className="muted">Normal OSRM time</span><span className="mono">{formatDuration(route.normalTime)}</span>
              <span className="muted">Congestion delay</span><span className="mono">+{formatDuration(route.congestionDelay)}</span>
              <span className="muted">Incident penalty</span><span className="mono">+{formatDuration(route.incidentPenalty)}</span>
              <strong style={{ paddingTop: 6, borderTop: "1px solid var(--border)" }}>Adjusted time</strong><strong className="mono" style={{ paddingTop: 6, borderTop: "1px solid var(--border)" }}>{formatDuration(route.adjustedTime)}</strong>
            </div>
          </div>

          {recommendation && recommendation.routes.length > 1 && (
            <div>
              <SectionTitle>Alternatives</SectionTitle>
              <div className="stack" style={{ gap: 6 }}>
                {recommendation.routes.map((option, index) => (
                  <div key={option.id} className="row" style={{ justifyContent: "space-between", padding: "9px 10px", border: "1px solid var(--border)", borderRadius: 8, background: index === 0 ? "var(--brand-tint)" : "var(--surface)" }}>
                    <span style={{ fontSize: 11.5 }}>{index === 0 ? "Recommended" : `Alternative ${index}`} · {formatDistance(option.distance)}</span>
                    <span className="mono" style={{ fontSize: 11 }}>{formatDuration(option.adjustedTime)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="faint" style={{ fontSize: 10.5, lineHeight: 1.45 }}>
            {recommendation?.trafficNote} {updatedAt ? `Last checked ${updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.` : ""}
          </div>
          <div className="row" style={{ gap: 10, flexWrap: "wrap", fontSize: 10.5 }} aria-label="Congestion severity legend">
            <span><i className="routing-legend-dot" style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "#f0b429", marginRight: 4 }} />Low</span>
            <span><i className="routing-legend-dot" style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "#e67e22", marginRight: 4 }} />Medium</span>
            <span><i className="routing-legend-dot" style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "#d64545", marginRight: 4 }} />High</span>
          </div>
        </>
      )}

      {loading && !route && <div className="muted" style={{ padding: 18, textAlign: "center" }}>Calculating OSRM routes and checking live traffic cameras…</div>}
      <style>{`
        .routing-update-button {
          color: #fff;
          background: #c56a19;
          border-color: #c56a19;
          animation: routing-update-pulse 1.6s ease-in-out infinite;
        }
        .routing-update-button:hover { background: #a95310; border-color: #a95310; }
        @keyframes routing-update-pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(197, 106, 25, 0.25); }
          50% { box-shadow: 0 0 0 5px rgba(197, 106, 25, 0.12); }
        }
      `}</style>
    </div>
  );
}

function routeSignature(route: RouteOption): string {
  const geometry = route.geometry
    .filter((_, index) => index === 0 || index === route.geometry.length - 1 || index % 8 === 0)
    .map(([lng, lat]) => `${lng.toFixed(4)},${lat.toFixed(4)}`)
    .join(";");
  return `${geometry}|${Math.round(route.adjustedTime)}|${route.nearbyCameraIds.slice().sort().join(",")}`;
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="faint" style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>{children}</div>;
}

function formatDuration(seconds: number): string {
  const mins = Math.max(0, Math.round(seconds / 60));
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function formatDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}
