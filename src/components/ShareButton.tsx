"use client";

// ── Share button ────────────────────────────────────────────────────
// Lets a customer hand their tracking link to someone else (a family
// member, another tenant, whoever is actually home for the visit) —
// right after booking and again from the tracking page itself. Uses the
// native share sheet where the browser supports it (mobile Safari/Chrome);
// falls back to copying the link to the clipboard everywhere else. Never
// touches the booking/job — purely a client-side convenience around the
// same public tracking URL the page itself is already showing.

import { useState } from "react";
import { STATUS_ICON } from "@/lib/icons";

export function ShareButton({
  url,
  title,
  text,
  className = "btn",
  style,
}: {
  url: string;
  title: string;
  text: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [copied, setCopied] = useState(false);

  async function onShare() {
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({ title, text, url });
      } catch {
        // Cancelled or unsupported mid-call — nothing to do, the user
        // simply closed the share sheet.
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (rare, e.g. insecure context) — silently no-op
      // rather than throw in front of the customer.
    }
  }

  const ShareIcon = STATUS_ICON.share;
  return (
    <button
      type="button"
      className={className}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, ...style }}
      onClick={onShare}
    >
      {copied ? (
        <>
          <STATUS_ICON.check size={14} strokeWidth={2.4} />
          Link copied!
        </>
      ) : (
        <>
          <ShareIcon size={14} strokeWidth={2.2} />
          Share
        </>
      )}
    </button>
  );
}
