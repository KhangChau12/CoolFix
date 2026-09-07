"use client";

import Link from "next/link";

const PERSONAS = [
  { key: "admin", href: "/admin", label: "Company" },
  { key: "technician", href: "/tech", label: "Technician" },
  { key: "customer", href: "/book", label: "Customer" },
] as const;

export function TopBar({
  active,
  context,
}: {
  active: "admin" | "technician" | "customer";
  /** Small monospace context pill, e.g. "DISPATCH CONSOLE · SG" */
  context: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 20,
        padding: "0 18px",
        height: 54,
        background: "var(--ink)",
        color: "var(--ink-text)",
        position: "sticky",
        top: 0,
        zIndex: 50,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 11, minWidth: 0 }}>
        <Link
          href="/"
          style={{
            width: 20,
            height: 20,
            borderRadius: 5,
            background: "var(--brand)",
            flexShrink: 0,
            display: "block",
          }}
        />
        <Link href="/" style={{ fontWeight: 600, letterSpacing: "-0.01em", color: "var(--ink-text)" }}>
          CoolFix
        </Link>
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10.5,
            color: "var(--ink-text-muted)",
            border: "1px solid var(--ink-border)",
            borderRadius: 4,
            padding: "2px 6px",
            whiteSpace: "nowrap",
          }}
        >
          {context}
        </div>
      </div>
      <div
        style={{
          display: "flex",
          gap: 2,
          background: "#242220",
          padding: 3,
          borderRadius: 8,
          flexShrink: 0,
        }}
      >
        {PERSONAS.map((p) => {
          const isActive = p.key === active;
          return (
            <Link
              key={p.key}
              href={p.href}
              style={{
                fontSize: 12.5,
                fontWeight: isActive ? 500 : 400,
                color: isActive ? "var(--ink-text)" : "var(--ink-text-muted)",
                background: isActive ? "#3a3733" : "transparent",
                borderRadius: 6,
                padding: "6px 12px",
              }}
            >
              {p.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
