"use client";

// ── Customer tracking page ─────────────────────────────────────────
// Public, token-gated view of one booking. No login, no session — the
// token in the URL *is* the access credential (see
// `/api/public/jobs/[token]`). Read-only: this page never mutates the
// job, the schedule, or any agent state — it only displays what the
// pipeline has already decided.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { TopBar } from "@/components/TopBar";
import MapView from "@/components/MapView";
import { ShareButton } from "@/components/ShareButton";

interface PublicTimelineStep {
  key: string;
  label: string;
  state: "done" | "current" | "upcoming";
}

interface PublicJobView {
  trackingToken: string;
  trackingCode: string;
  status: string;
  statusLabel: string;
  message: string;
  appointment: { date: string; start: string; end: string };
  service: { category: string; summary: string };
  technician: { name: string; specialty: string } | null;
  location: { lat: number; lng: number };
  technicianLocation: { lat: number; lng: number } | null;
  eta: number | null;
  price: number;
  timeline: PublicTimelineStep[];
  explanation: string | null;
  disruption: { headline: string; detail: string } | null;
}

const POLL_MS = 4000;

export default function TrackTokenPage() {
  const params = useParams<{ token: string }>();
  const token = decodeURIComponent(String(params.token ?? ""));

  const [view, setView] = useState<PublicJobView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [mapOk, setMapOk] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/public/jobs/${encodeURIComponent(token)}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) {
        setError(j.error ?? "Tracking code not found. Please check the code and try again.");
        setView(null);
      } else {
        setView(j as PublicJobView);
        setError(null);
      }
    } catch {
      setError("Couldn't reach CoolFix right now. Please try again shortly.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-customer)" }}>
      <TopBar active="tracking" context="TRACK MY SERVICE · SG" />
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "22px 20px 72px" }}>
        {loading && !view && !error && (
          <div className="card" style={{ padding: 24, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
            Loading your service status…
          </div>
        )}

        {error && (
          <div className="card" style={{ padding: 24 }}>
            <h1 style={{ fontSize: 18, margin: 0 }}>We couldn&apos;t find that booking</h1>
            <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>{error}</p>
            <div className="row" style={{ gap: 8, marginTop: 16 }}>
              <Link href="/track" className="btn btn-primary">Try another code</Link>
              <Link href="/book" className="btn btn-ghost">Book a service</Link>
            </div>
          </div>
        )}

        {view && <TrackerCard view={view} mapOk={mapOk} onMapFail={() => setMapOk(false)} />}
      </div>
    </div>
  );
}

function TrackerCard({
  view,
  mapOk,
  onMapFail,
}: {
  view: PublicJobView;
  mapOk: boolean;
  onMapFail: () => void;
}) {
  const active = view.status === "en_route";
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="card" style={{ padding: 24 }}>
        <div className="faint" style={{ fontSize: 11, letterSpacing: "0.04em", marginBottom: 4 }}>
          COOLFIX
        </div>
        <h1 style={{ fontSize: 21, margin: 0, lineHeight: 1.3 }}>{view.statusLabel}</h1>
        <p className="muted" style={{ fontSize: 13, marginTop: 8, marginBottom: 0 }}>{view.message}</p>

        <div style={{ marginTop: 12 }}>
          <ShareButton
            url={typeof window !== "undefined" ? window.location.href : ""}
            title="CoolFix — my service status"
            text={`${view.statusLabel} (code ${view.trackingCode}):`}
          />
        </div>

        {view.eta != null && (
          <div style={{ marginTop: 16, display: "flex", alignItems: "baseline", gap: 8 }}>
            <span className="faint" style={{ fontSize: 11, textTransform: "uppercase" }}>ETA</span>
            <span className="mono" style={{ fontSize: 28, fontWeight: 600, letterSpacing: "-0.02em" }}>
              {view.eta} min
            </span>
          </div>
        )}

        {mapOk ? (
          <div style={{ marginTop: 16 }}>
            <MapView
              mode="display"
              customer={{ lat: view.location.lat, lng: view.location.lng, address: view.service.category }}
              technician={
                view.technicianLocation && view.technician
                  ? { lat: view.technicianLocation.lat, lng: view.technicianLocation.lng, name: view.technician.name }
                  : null
              }
              active={active}
              onUnavailable={onMapFail}
              height={220}
            />
          </div>
        ) : null}

        {view.technician && (
          <div
            className="row"
            style={{
              gap: 12,
              marginTop: 14,
              padding: "12px 14px",
              borderRadius: 10,
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
            }}
          >
            <span
              aria-hidden
              style={{
                width: 40,
                height: 40,
                borderRadius: 999,
                background: "var(--brand-tint)",
                display: "grid",
                placeItems: "center",
                fontSize: 16,
                flexShrink: 0,
              }}
            >
              🧑‍🔧
            </span>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{view.technician.name}</div>
              <div className="muted" style={{ fontSize: 12 }}>{view.technician.specialty}</div>
            </div>
          </div>
        )}

        <dl
          style={{
            fontSize: 12.5,
            display: "grid",
            gridTemplateColumns: "110px 1fr",
            gap: "6px 12px",
            marginTop: 16,
            paddingTop: 14,
            borderTop: "1px solid var(--border)",
          }}
        >
          <dt className="muted">Appointment</dt>
          <dd style={{ margin: 0 }}>
            {view.appointment.date} · {view.appointment.start}–{view.appointment.end}
          </dd>
          <dt className="muted">Service</dt>
          <dd style={{ margin: 0 }}>{view.service.summary || view.service.category}</dd>
          <dt className="muted">Price</dt>
          <dd style={{ margin: 0 }}>{view.price} SGD</dd>
        </dl>
      </div>

      {view.disruption && (
        <div
          className="card"
          style={{ padding: 16, borderLeft: "3px solid var(--tier-priority)", background: "var(--surface)" }}
        >
          <strong style={{ fontSize: 13 }}>{view.disruption.headline}</strong>
          <p className="muted" style={{ fontSize: 12.5, margin: "6px 0 0" }}>{view.disruption.detail}</p>
        </div>
      )}

      <div className="card" style={{ padding: 20 }}>
        <strong style={{ fontSize: 13 }}>Service timeline</strong>
        <div style={{ display: "grid", gap: 0, marginTop: 10 }}>
          {view.timeline.map((step) => (
            <div key={step.key} className="row" style={{ gap: 10, padding: "6px 0" }}>
              <span
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 999,
                  border: `2px solid ${
                    step.state === "done"
                      ? "var(--tier-flexible)"
                      : step.state === "current"
                      ? "var(--brand)"
                      : "var(--border-strong)"
                  }`,
                  background: step.state === "done" ? "var(--tier-flexible)" : "transparent",
                  color: "#fff",
                  fontSize: 11,
                  display: "grid",
                  placeItems: "center",
                  flex: "none",
                }}
              >
                {step.state === "done" ? "✓" : step.state === "current" ? "●" : ""}
              </span>
              <span
                style={{
                  fontSize: 13,
                  color: step.state === "upcoming" ? "var(--text-faint)" : "var(--text)",
                  fontWeight: step.state === "current" ? 600 : 400,
                }}
              >
                {step.label}
              </span>
            </div>
          ))}
        </div>
      </div>

      {view.explanation && (
        <div className="card" style={{ padding: 20 }}>
          <strong style={{ fontSize: 13 }}>Why was this technician selected?</strong>
          <p className="muted" style={{ fontSize: 12.5, marginTop: 8, marginBottom: 0, lineHeight: 1.55 }}>
            {view.explanation}
          </p>
        </div>
      )}

      <div className="row" style={{ justifyContent: "space-between", fontSize: 11.5, padding: "0 4px" }}>
        <span className="faint">Tracking code: {view.trackingCode}</span>
        <Link href="/track" className="faint" style={{ textDecoration: "underline" }}>
          Track another booking
        </Link>
      </div>
    </div>
  );
}
