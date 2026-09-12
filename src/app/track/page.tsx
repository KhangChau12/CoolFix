"use client";

// Public entry point: "Track My Service" — a customer types in the
// tracking code they got at booking time and is sent to /track/:token.
// No account, no login: the code itself is the credential. We don't call
// the API here at all — a bad code is validated once the token page loads
// and shows a generic "not found" message (never "that code doesn't
// exist" vs. "wrong format", so this page can't be used to enumerate).

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TopBar } from "@/components/TopBar";
import { normalizeTrackingTokenInput } from "@/lib/trackingTokenFormat";

export default function TrackEntryPage() {
  const router = useRouter();
  const [code, setCode] = useState("");

  function go() {
    const token = normalizeTrackingTokenInput(code);
    if (!token) return;
    router.push(`/track/${encodeURIComponent(token)}`);
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-customer)" }}>
      <TopBar active="customer" context="TRACK MY SERVICE · SG" />
      <div style={{ maxWidth: 460, margin: "0 auto", padding: "22px 20px 72px" }}>
        <div className="card" style={{ padding: 28 }}>
          <h1 style={{ fontSize: 20, margin: 0 }}>Track your CoolFix service</h1>
          <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
            Enter the tracking code you received when you booked — no account needed.
          </p>

          <label style={{ display: "block", fontSize: 12, marginTop: 18 }}>
            <span className="muted" style={{ fontWeight: 600 }}>Tracking code</span>
            <input
              className="inp"
              style={{ marginTop: 6, textTransform: "uppercase", letterSpacing: "0.04em" }}
              placeholder="CF-XXXX-XXXX-XXXX"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") go();
              }}
              autoFocus
            />
          </label>

          <button className="btn btn-primary btn-lg" style={{ marginTop: 16, width: "100%" }} disabled={!code.trim()} onClick={go}>
            Track service
          </button>
        </div>
      </div>

      <style>{`
        .inp {
          width: 100%; padding: 9px 11px; border: 1px solid var(--border-strong);
          border-radius: 8px; font-size: 13px; background: var(--surface);
        }
        .inp:focus { outline: 2px solid var(--brand-tint); border-color: var(--brand); }
      `}</style>
    </div>
  );
}
