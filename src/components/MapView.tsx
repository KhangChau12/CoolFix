"use client";

// ── MapView ─────────────────────────────────────────────────────────
// One Leaflet map, two modes:
//
//   mode="pick"     — customer booking form. A draggable marker + an
//                     address search box (OpenStreetMap Nominatim). The
//                     picked { lat, lng, address } flows up via onPick.
//   mode="display"  — customer tracker. Read-only. Shows the customer's
//                     address and, once a technician is assigned, the
//                     technician's base with a connecting line and the
//                     straight-line distance. Auto-fits both points.
//
// Everything runs in the browser: Leaflet is dynamically imported on
// mount (no SSR), tiles come straight from openstreetmap.org, geocoding
// hits Nominatim directly. The backend only ever receives { lat, lng } —
// the agent pipeline is unchanged.
//
// Nothing here is load-bearing for the demo: if Leaflet fails to load,
// tiles are blocked, or Nominatim is unreachable, the parent renders a
// plain fallback (a landmark dropdown in "pick", an address card in
// "display"). See `onUnavailable`.

import { useCallback, useEffect, useRef, useState } from "react";
import { clampToSG, distanceKm, isWithinSG, SG_CENTER } from "@/lib/geo";

type L = typeof import("leaflet");
type LeafletMap = import("leaflet").Map;
type LeafletMarker = import("leaflet").Marker;
type LeafletPolyline = import("leaflet").Polyline;

const LEAFLET_VERSION = "1.9.4";
const LEAFLET_CSS = `https://cdnjs.cloudflare.com/ajax/libs/leaflet/${LEAFLET_VERSION}/leaflet.min.css`;
// CARTO's "voyager" style, not the default OSM standard style — it renders
// place labels in English consistently (the default OSM tiles show local-
// script labels for Singapore locations, e.g. Chinese names in Chinatown,
// with no way to force English via the raster tile URL).
const TILE_URL = "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";
const TILE_ATTRIB =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
  '&copy; <a href="https://carto.com/attributions">CARTO</a>';
const NOMINATIM = "https://nominatim.openstreetmap.org";

export interface PickedPlace {
  lat: number;
  lng: number;
  address: string;
}

interface CommonProps {
  /** Called once if Leaflet / tiles / geocoding can't be used, so the
   * parent can show its non-map fallback instead. */
  onUnavailable?: () => void;
  height?: number;
  className?: string;
}

interface PickProps extends CommonProps {
  mode: "pick";
  value: PickedPlace | null;
  onPick: (place: PickedPlace) => void;
}

export interface MapPin {
  lat: number;
  lng: number;
  label: string;
  /** "customer" (blue) | "tech" (amber) | "alt" (green) — picks the pin colour. */
  role?: "customer" | "tech" | "alt";
}

interface DisplayProps extends CommonProps {
  mode: "display";
  customer: { lat: number; lng: number; address: string };
  technician?: { lat: number; lng: number; name: string } | null;
  /** Tighten the visual style when the technician is en route. */
  active?: boolean;
  /** Extra read-only markers (no connecting line) — e.g. other jobs a
   * re-plan would move. Included in the auto-fit. */
  extras?: MapPin[];
}

type Props = PickProps | DisplayProps;

// ── Leaflet loader (module-level, shared across mounts) ─────────────

let leafletPromise: Promise<L> | null = null;

function loadLeaflet(): Promise<L> {
  if (leafletPromise) return leafletPromise;
  leafletPromise = (async () => {
    if (!document.getElementById("leaflet-css")) {
      const link = document.createElement("link");
      link.id = "leaflet-css";
      link.rel = "stylesheet";
      link.href = LEAFLET_CSS;
      document.head.appendChild(link);
    }
    const mod = await import("leaflet");
    return (mod.default ?? mod) as L;
  })();
  return leafletPromise;
}

// ── Nominatim geocoding (rate-limited, best-effort) ────────────────
// Usage policy: max 1 req/s, identify the app. We only call on an
// explicit "Search" press or a marker drag, never per keystroke.

let lastGeocodeAt = 0;

async function throttle() {
  const wait = 1100 - (Date.now() - lastGeocodeAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastGeocodeAt = Date.now();
}

async function geocode(query: string): Promise<PickedPlace[]> {
  await throttle();
  const url =
    `${NOMINATIM}/search?format=jsonv2&limit=5&countrycodes=sg` +
    `&addressdetails=1&accept-language=en&q=${encodeURIComponent(query)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: "application/json", "Accept-Language": "en" },
    });
    if (!r.ok) return [];
    const rows = (await r.json()) as Array<{
      lat: string;
      lon: string;
      display_name: string;
    }>;
    return rows
      .map((row) => ({
        lat: Number(row.lat),
        lng: Number(row.lon),
        address: row.display_name,
      }))
      .filter((p) => isWithinSG(p));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function reverseGeocode(lat: number, lng: number): Promise<string> {
  await throttle();
  const url = `${NOMINATIM}/reverse?format=jsonv2&lat=${lat}&lon=${lng}&accept-language=en`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: "application/json", "Accept-Language": "en" },
    });
    if (!r.ok) return "";
    const row = (await r.json()) as { display_name?: string };
    return row.display_name ?? "";
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

function coordLabel(lat: number, lng: number): string {
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

function makePinIcon(L: L, color: string): import("leaflet").DivIcon {
  return L.divIcon({
    className: "mv-pin-wrap",
    html: `<span class="mv-pin" style="--pin:${color}"></span>`,
    iconSize: [24, 24],
    iconAnchor: [12, 22],
    popupAnchor: [0, -20],
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!),
  );
}

// ── Component ──────────────────────────────────────────────────────

export default function MapView(props: Props) {
  const { mode, onUnavailable, height = 260, className } = props;

  const holderRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const lRef = useRef<L | null>(null);
  const custMarkerRef = useRef<LeafletMarker | null>(null);
  const techMarkerRef = useRef<LeafletMarker | null>(null);
  const lineRef = useRef<LeafletPolyline | null>(null);
  const extraMarkersRef = useRef<LeafletMarker[]>([]);

  // Keep the latest onPick in a ref so the map-init effect can stay
  // mount-only without going stale.
  const onPickRef = useRef<((p: PickedPlace) => void) | null>(null);
  onPickRef.current = props.mode === "pick" ? props.onPick : null;

  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);

  const fail = useCallback(() => {
    setFailed(true);
    onUnavailable?.();
  }, [onUnavailable]);

  // Emit a pick, resolving the address if we weren't handed one.
  const emitPick = useCallback(async (lat: number, lng: number, address?: string) => {
    const p = clampToSG({ lat, lng });
    const addr = address ?? (await reverseGeocode(p.lat, p.lng));
    onPickRef.current?.({
      lat: p.lat,
      lng: p.lng,
      address: addr || coordLabel(p.lat, p.lng),
    });
  }, []);

  // ── init map once ──
  useEffect(() => {
    let cancelled = false;
    const initCenter =
      props.mode === "display"
        ? props.customer
        : props.value ?? SG_CENTER;

    // If Leaflet's JS never loads, or the basemap tiles are blocked, fall
    // back to the parent's non-map input. `.catch(fail)` handles the JS.
    // For tiles: after a grace period, look at the DOM — if not a single
    // <img.leaflet-tile> actually decoded (naturalWidth > 0), the basemap
    // host is unreachable and the map is useless, so hand off.
    let tileTimer: ReturnType<typeof setTimeout> | null = null;

    loadLeaflet()
      .then((L) => {
        if (cancelled || !holderRef.current) return;
        lRef.current = L;
        const map = L.map(holderRef.current, {
          center: [initCenter.lat, initCenter.lng],
          zoom: 13,
          zoomControl: props.mode === "pick",
          scrollWheelZoom: props.mode === "pick",
        });
        L.tileLayer(TILE_URL, { attribution: TILE_ATTRIB, maxZoom: 19 }).addTo(map);

        if (props.mode === "pick") {
          map.on("click", (e: import("leaflet").LeafletMouseEvent) => {
            void emitPick(e.latlng.lat, e.latlng.lng);
          });
        }

        mapRef.current = map;
        // `invalidateSize()` must run BEFORE the marker/fit-bounds effect
        // sees `ready=true` — Leaflet computes `fitBounds()`'s zoom off the
        // container's current pixel size, and right after `L.map()` that
        // size can still be stale (0×0, or mid-layout) if the holder hasn't
        // finished its own CSS layout pass yet. Setting `ready` first let
        // the fit-bounds effect run against a wrong size, which is what
        // produced the "zoomed out to all of Malaysia" symptom — not bad
        // coordinates. `requestAnimationFrame` (not a raw setTimeout) is
        // enough to land after layout without an arbitrary delay.
        requestAnimationFrame(() => {
          if (cancelled) return;
          map.invalidateSize();
          setReady(true);
        });

        tileTimer = setTimeout(() => {
          if (cancelled || !holderRef.current) return;
          const imgs = Array.from(
            holderRef.current.querySelectorAll<HTMLImageElement>("img.leaflet-tile"),
          );
          const anyDecoded = imgs.some((im) => im.complete && im.naturalWidth > 0);
          if (imgs.length > 0 && !anyDecoded) fail();
        }, 6000);
      })
      .catch(fail);

    return () => {
      cancelled = true;
      if (tileTimer) clearTimeout(tileTimer);
      mapRef.current?.remove();
      mapRef.current = null;
      custMarkerRef.current = null;
      techMarkerRef.current = null;
      lineRef.current = null;
      extraMarkersRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── pick mode: reflect `value` onto the marker ──
  const pickLat = props.mode === "pick" ? props.value?.lat ?? null : null;
  const pickLng = props.mode === "pick" ? props.value?.lng ?? null : null;

  useEffect(() => {
    if (mode !== "pick" || !ready || failed || pickLat == null || pickLng == null) return;
    if (!lRef.current || !mapRef.current) return;
    const L = lRef.current;
    const map = mapRef.current;

    if (!custMarkerRef.current) {
      const m = L.marker([pickLat, pickLng], {
        draggable: true,
        icon: makePinIcon(L, "var(--tier-standard)"),
      }).addTo(map);
      m.on("dragend", () => {
        const ll = m.getLatLng();
        const snapped = clampToSG({ lat: ll.lat, lng: ll.lng });
        m.setLatLng([snapped.lat, snapped.lng]);
        void emitPick(snapped.lat, snapped.lng);
      });
      custMarkerRef.current = m;
    } else {
      custMarkerRef.current.setLatLng([pickLat, pickLng]);
    }
    map.setView([pickLat, pickLng], Math.max(map.getZoom(), 15));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, mode, pickLat, pickLng]);

  // ── display mode: customer + technician markers, line, fit ──
  const dCustLat = props.mode === "display" ? props.customer.lat : null;
  const dCustLng = props.mode === "display" ? props.customer.lng : null;
  const dTechLat = props.mode === "display" ? props.technician?.lat ?? null : null;
  const dTechLng = props.mode === "display" ? props.technician?.lng ?? null : null;
  const dActive = props.mode === "display" ? Boolean(props.active) : false;
  const dExtras = props.mode === "display" ? props.extras ?? null : null;
  const dExtrasKey = dExtras
    ? dExtras.map((e) => `${e.lat.toFixed(4)},${e.lng.toFixed(4)},${e.role ?? ""}`).join("|")
    : "";

  useEffect(() => {
    if (mode !== "display" || !ready || failed || dCustLat == null || dCustLng == null) return;
    if (!lRef.current || !mapRef.current) return;
    const L = lRef.current;
    const map = mapRef.current;
    const p = props as DisplayProps;

    if (!custMarkerRef.current) {
      custMarkerRef.current = L.marker([dCustLat, dCustLng], {
        icon: makePinIcon(L, "var(--tier-standard)"),
      })
        .addTo(map)
        .bindPopup(`<b>Your address</b><br>${escapeHtml(p.customer.address)}`);
    } else {
      custMarkerRef.current.setLatLng([dCustLat, dCustLng]);
    }

    // Extra read-only markers (other jobs a re-plan touches). Rebuilt
    // whenever the set changes — small counts, so a clear-and-readd is fine.
    const EXTRA_COLOR = { customer: "var(--tier-standard)", tech: "var(--tier-priority)", alt: "var(--tier-flexible)" };
    for (const m of extraMarkersRef.current) m.remove();
    extraMarkersRef.current = [];
    if (dExtras) {
      for (const e of dExtras) {
        const m = L.marker([e.lat, e.lng], {
          icon: makePinIcon(L, EXTRA_COLOR[e.role ?? "alt"]),
        })
          .addTo(map)
          .bindPopup(escapeHtml(e.label));
        extraMarkersRef.current.push(m);
      }
    }

    if (dTechLat != null && dTechLng != null && p.technician) {
      const techColor = dActive ? "var(--tier-urgent)" : "var(--tier-priority)";
      if (!techMarkerRef.current) {
        techMarkerRef.current = L.marker([dTechLat, dTechLng], {
          icon: makePinIcon(L, techColor),
        }).addTo(map);
      } else {
        techMarkerRef.current
          .setLatLng([dTechLat, dTechLng])
          .setIcon(makePinIcon(L, techColor));
      }
      techMarkerRef.current.bindPopup(
        `<b>${escapeHtml(p.technician.name)}</b><br>${
          dActive ? "On the way" : "Assigned technician"
        }`,
      );

      const pts: [number, number][] = [
        [dCustLat, dCustLng],
        [dTechLat, dTechLng],
      ];
      const style = {
        color: dActive ? "var(--tier-urgent)" : "var(--text-faint)",
        weight: 2,
        opacity: 0.85,
        dashArray: dActive ? undefined : "5 6",
      };
      if (!lineRef.current) {
        lineRef.current = L.polyline(pts, style).addTo(map);
      } else {
        lineRef.current.setLatLngs(pts);
        lineRef.current.setStyle(style);
      }
      const fitPts = [...pts, ...(dExtras?.map((e) => [e.lat, e.lng] as [number, number]) ?? [])].filter(
        (pt) => isWithinSG({ lat: pt[0], lng: pt[1] }),
      );
      if (fitPts.length >= 2) {
        map.fitBounds(L.latLngBounds(fitPts).pad(0.35), { animate: false, maxZoom: 15 });
      } else {
        map.setView([dCustLat, dCustLng], 14, { animate: false });
      }
    } else if (dExtras && dExtras.length > 0) {
      const fitPts = (
        [
          [dCustLat, dCustLng],
          ...dExtras.map((e) => [e.lat, e.lng] as [number, number]),
        ] as [number, number][]
      ).filter((pt) => isWithinSG({ lat: pt[0], lng: pt[1] }));
      if (fitPts.length >= 2) {
        map.fitBounds(L.latLngBounds(fitPts).pad(0.35), { animate: false, maxZoom: 15 });
      } else {
        map.setView([dCustLat, dCustLng], 14, { animate: false });
      }
    } else {
      map.setView([dCustLat, dCustLng], 14, { animate: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, mode, dCustLat, dCustLng, dTechLat, dTechLng, dActive, dExtrasKey]);

  // ── search box (pick only) ──
  const [q, setQ] = useState("");
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<PickedPlace[] | null>(null);

  const applyHit = useCallback((hit: PickedPlace) => {
    setHits(null);
    setQ(hit.address);
    onPickRef.current?.(hit);
    mapRef.current?.setView([hit.lat, hit.lng], 16);
  }, []);

  const runSearch = useCallback(async () => {
    const term = q.trim();
    if (!term) return;
    setSearching(true);
    setHits(null);
    const results = await geocode(term);
    setSearching(false);
    if (results.length === 0) setHits([]);
    else if (results.length === 1) applyHit(results[0]);
    else setHits(results);
  }, [q, applyHit]);

  if (failed) return null; // parent shows its fallback

  return (
    <div className={className}>
      {mode === "pick" && (
        <div style={{ marginBottom: 8 }}>
          <div className="row" style={{ gap: 6 }}>
            <input
              className="mv-search"
              placeholder="Search your address (e.g. Blk 210 Bishan St 23)"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void runSearch();
                }
              }}
            />
            <button
              type="button"
              className="btn"
              onClick={() => void runSearch()}
              disabled={searching || !q.trim()}
            >
              {searching ? "…" : "Search"}
            </button>
          </div>
          {hits && hits.length === 0 && (
            <p className="faint" style={{ fontSize: 11.5, margin: "6px 0 0" }}>
              No match in Singapore. Try a nearby landmark, or click the map to
              drop the pin where you are.
            </p>
          )}
          {hits && hits.length > 1 && (
            <div className="mv-hits">
              {hits.map((h, i) => (
                <button
                  key={i}
                  type="button"
                  className="mv-hit"
                  onClick={() => applyHit(h)}
                >
                  {h.address}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div
        ref={holderRef}
        className="mv-holder"
        style={{ height }}
        aria-label={
          mode === "pick" ? "Pick your location on the map" : "Service location map"
        }
      />

      {mode === "pick" && (
        <p className="faint" style={{ fontSize: 11, margin: "6px 0 0" }}>
          Search an address above, or click / drag the pin to fine-tune it.
        </p>
      )}
      {mode === "display" && props.technician && (
        <p className="muted" style={{ fontSize: 11.5, margin: "6px 0 0" }}>
          {props.active ? "Technician en route · " : "Assigned · "}~
          {distanceKm(props.customer, props.technician).toFixed(1)} km away
          (straight line)
        </p>
      )}

      <style>{`
        .mv-holder {
          width: 100%;
          /* Keep Leaflet's internal panes (markers/controls use high
             z-indexes) below the sticky CoolFix top bars. */
          position: relative;
          z-index: 0;
          isolation: isolate;
          border-radius: 10px;
          overflow: hidden;
          border: 1px solid var(--border);
          background: var(--surface-2);
        }
        .mv-holder .leaflet-container { font: inherit; background: var(--surface-2); }
        .mv-search {
          flex: 1;
          padding: 9px 11px;
          border: 1px solid var(--border-strong);
          border-radius: 8px;
          font-size: 13px;
          background: var(--surface);
        }
        .mv-search:focus { outline: 2px solid var(--brand-tint); border-color: var(--brand); }
        .mv-hits {
          margin-top: 6px;
          border: 1px solid var(--border);
          border-radius: 8px;
          overflow: hidden;
          background: var(--surface);
        }
        .mv-hit {
          display: block;
          width: 100%;
          text-align: left;
          padding: 8px 10px;
          font-size: 12px;
          background: var(--surface);
          border: none;
          border-bottom: 1px solid var(--border);
          color: var(--text);
        }
        .mv-hit:last-child { border-bottom: none; }
        .mv-hit:hover { background: var(--surface-2); }
        .mv-pin-wrap { background: none; border: none; }
        .mv-pin {
          display: block;
          width: 18px;
          height: 18px;
          border-radius: 50% 50% 50% 0;
          background: var(--pin, var(--tier-standard));
          border: 2px solid #fff;
          box-shadow: 0 1px 4px rgba(0,0,0,0.35);
          transform: rotate(-45deg);
        }
      `}</style>
    </div>
  );
}
