"use client";

import type { ReactNode } from "react";
import { TIER_META, type JobStatus, type Tier } from "@/lib/types";

export function TierBadge({ tier }: { tier: Tier }) {
  const m = TIER_META[tier];
  return (
    <span className={`tier-badge ${tier}`}>
      {m.emoji} {m.label}
    </span>
  );
}

const STATUS_LABEL: Record<JobStatus, string> = {
  pending: "Pending",
  assigned: "Assigned",
  frozen: "Frozen",
  in_progress: "In progress",
  completed: "Completed",
  disrupted: "Disrupted",
};

export function StatusDot({ status, label }: { status: JobStatus; label?: boolean }) {
  return (
    <span className="row" style={{ gap: 6 }}>
      <span className={`status-dot ${status}`} />
      {label && <span className="muted" style={{ fontSize: 12 }}>{STATUS_LABEL[status]}</span>}
    </span>
  );
}

export function Metric({
  label,
  value,
  hint,
  accent,
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  accent?: string;
  icon?: ReactNode;
}) {
  const barColor = accent ?? "var(--border-strong)";
  return (
    <div
      className="card"
      style={{
        padding: "15px 16px 15px 18px",
        position: "relative",
        overflow: "hidden",
        transition: "box-shadow 0.15s, transform 0.15s",
      }}
    >
      <span
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: 3,
          background: barColor,
          opacity: accent ? 1 : 0.5,
        }}
      />
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div
          className="muted"
          style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}
        >
          {label}
        </div>
        {icon && (
          <span style={{ fontSize: 14, opacity: 0.55, lineHeight: 1 }}>{icon}</span>
        )}
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, marginTop: 6, color: accent ?? "var(--text)", letterSpacing: "-0.01em" }}>
        {value}
      </div>
      {hint && <div className="faint" style={{ fontSize: 11.5, marginTop: 3 }}>{hint}</div>}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="row muted" style={{ gap: 8, padding: 20, fontSize: 13 }}>
      <span
        style={{
          width: 14,
          height: 14,
          border: "2px solid var(--border-strong)",
          borderTopColor: "var(--brand)",
          borderRadius: 999,
          animation: "spin 0.7s linear infinite",
          display: "inline-block",
        }}
      />
      {label ?? "Loading…"}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      className="card"
      style={{ padding: 28, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}
    >
      {children}
    </div>
  );
}

export function Toast({
  message,
  kind = "info",
  onClose,
}: {
  message: string;
  kind?: "info" | "success" | "error";
  onClose: () => void;
}) {
  const bg =
    kind === "success" ? "var(--success)" : kind === "error" ? "var(--danger-strong)" : "var(--ink)";
  return (
    <div
      style={{
        position: "fixed",
        bottom: 24,
        left: "50%",
        transform: "translateX(-50%)",
        background: bg,
        color: "#fff",
        padding: "12px 20px",
        borderRadius: 10,
        boxShadow: "var(--shadow-lg)",
        fontSize: 13,
        fontWeight: 600,
        zIndex: 1000,
        maxWidth: 520,
        animation: "slideIn 0.2s ease",
      }}
      onClick={onClose}
      role="status"
    >
      {message}
    </div>
  );
}
