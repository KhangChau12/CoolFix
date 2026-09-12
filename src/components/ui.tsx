"use client";

import type { CSSProperties, ReactNode } from "react";
import { TIER_META, type JobStatus, type Tier } from "@/lib/types";
import { TIER_ICON } from "@/lib/icons";
import type { LucideIcon } from "lucide-react";

export function TierBadge({ tier }: { tier: Tier }) {
  const m = TIER_META[tier];
  const Icon = TIER_ICON[tier];
  return (
    <span className={`tier-badge ${tier}`}>
      <Icon size={11} strokeWidth={2.25} />
      {m.label}
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
    </div>
  );
}

/** Small colored rounded-square housing a Lucide icon — landing persona cards,
 *  empty states, section header accents. Shape only; caller supplies color. */
export function IconTile({
  icon: Icon,
  accent = "var(--brand)",
  tint = "var(--brand-tint)",
  size = 40,
  iconSize = 18,
}: {
  icon: LucideIcon;
  accent?: string;
  tint?: string;
  size?: number;
  iconSize?: number;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: size >= 32 ? 12 : 8,
        background: tint,
        color: accent,
        flex: "none",
      }}
    >
      <Icon size={iconSize} strokeWidth={2} />
    </span>
  );
}

/** Thin wrapper around `.card` — additive convenience, existing `className="card"`
 *  call sites keep working unchanged. */
export function Card({
  children,
  padding = 16,
  variant = "default",
  style,
  className = "",
}: {
  children: ReactNode;
  padding?: number | string;
  variant?: "default" | "flush" | "tinted";
  style?: CSSProperties;
  className?: string;
}) {
  const variantStyle: CSSProperties =
    variant === "tinted"
      ? { background: "var(--surface-2)" }
      : variant === "flush"
      ? { boxShadow: "none" }
      : {};
  return (
    <div
      className={`card ${className}`.trim()}
      style={{ padding, ...variantStyle, ...style }}
    >
      {children}
    </div>
  );
}

const BTN_VARIANT_CLASS: Record<string, string> = {
  default: "btn",
  primary: "btn btn-primary",
  approve: "btn btn-approve",
  danger: "btn btn-danger",
  ghost: "btn btn-ghost",
};

/** Typed wrapper over the existing `.btn*` CSS classes — additive, doesn't
 *  replace raw `className="btn ..."` call sites. */
export function Button({
  children,
  variant = "default",
  size = "md",
  icon: Icon,
  onClick,
  type = "button",
  disabled,
  style,
  title,
}: {
  children?: ReactNode;
  variant?: "default" | "primary" | "approve" | "danger" | "ghost";
  size?: "md" | "lg";
  icon?: LucideIcon;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
  style?: CSSProperties;
  title?: string;
}) {
  const cls = `${BTN_VARIANT_CLASS[variant]}${size === "lg" ? " btn-lg" : ""}`;
  return (
    <button className={cls} onClick={onClick} type={type} disabled={disabled} style={style} title={title}>
      {Icon && <Icon size={size === "lg" ? 16 : 14} strokeWidth={2.25} />}
      {children}
    </button>
  );
}

/** Empty-state block with an optional icon tile, title, and action —
 *  the plain-text variant (no props beyond children) still works as before. */
export function EmptyState({
  children,
  icon,
  title,
  action,
}: {
  children: ReactNode;
  icon?: LucideIcon;
  title?: string;
  action?: ReactNode;
}) {
  return (
    <div
      className="card"
      style={{ padding: 28, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}
    >
      {icon && (
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
          <IconTile icon={icon} accent="var(--text-faint)" tint="var(--illustration-tint)" size={44} iconSize={20} />
        </div>
      )}
      {title && (
        <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>
          {title}
        </div>
      )}
      {children}
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  );
}

export interface BarDatum {
  label: string;
  value: number;
  color: string;
  hint?: string;
}

/** Small hand-rolled SVG horizontal bar chart — no charting dependency,
 *  matches AgentFlowMap's hand-rolled-SVG house style. Replaces flat
 *  `<span style={{width:'%'}}>` bars with real per-segment color + labels. */
export function MiniBarChart({
  data,
  max,
  height = 8,
  gap = 10,
  showValue = true,
}: {
  data: BarDatum[];
  max?: number;
  height?: number;
  gap?: number;
  showValue?: boolean;
}) {
  const m = max ?? Math.max(1, ...data.map((d) => d.value));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap }}>
      {data.map((d) => {
        const pct = m > 0 ? Math.min(100, (d.value / m) * 100) : 0;
        return (
          <div key={d.label}>
            <div className="row" style={{ justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600 }}>{d.label}</span>
              {showValue && (
                <span style={{ fontSize: 12, fontWeight: 700, color: d.color }}>
                  {d.hint ?? d.value}
                </span>
              )}
            </div>
            <div
              style={{
                height,
                borderRadius: height,
                background: "var(--surface-2)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${pct}%`,
                  borderRadius: height,
                  background: d.color,
                  transition: "width 0.3s ease",
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Single inline sparkline-style bar (no label rows) — for dense table cells. */
export function Sparkline({
  value,
  max = 100,
  color,
  width = 64,
  height = 6,
}: {
  value: number;
  max?: number;
  color: string;
  width?: number | string;
  height?: number;
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div
      style={{
        width,
        height,
        borderRadius: height,
        background: "var(--surface-2)",
        overflow: "hidden",
        flex: "none",
      }}
    >
      <div
        style={{
          height: "100%",
          width: `${pct}%`,
          borderRadius: height,
          background: color,
          transition: "width 0.3s ease",
        }}
      />
    </div>
  );
}

/** Shared with the Gantt chart (`admin/schedule`) so the same technician
 *  always gets the same color everywhere they appear — roster, queue,
 *  schedule. Deliberately a plain array + index, not a hash, so the first
 *  few technicians in the roster get visually distinct, high-contrast
 *  colors rather than whatever a hash happens to produce. */
export const AVATAR_COLORS = ["#4f46e5", "#b07830", "#6d4fd6", "#45825a", "#b2483f", "#2f7d8c"];

export function initials(name: string): string {
  return name
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/** Colored initials badge — replaces stock-photo avatars app-wide. `index`
 *  picks the color (pass the technician's position in the roster so the
 *  same person gets the same color on every page). */
export function Avatar({
  name,
  index,
  size = 38,
}: {
  name: string;
  index: number;
  size?: number;
}) {
  const color = AVATAR_COLORS[((index % AVATAR_COLORS.length) + AVATAR_COLORS.length) % AVATAR_COLORS.length];
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: 999,
        background: color,
        color: "#fff",
        display: "grid",
        placeItems: "center",
        fontSize: Math.max(10, Math.round(size * 0.36)),
        fontWeight: 700,
        flex: "none",
        letterSpacing: "-0.02em",
      }}
    >
      {initials(name)}
    </span>
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
