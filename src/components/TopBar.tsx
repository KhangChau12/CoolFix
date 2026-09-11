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
    <header
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 20,
        padding: "0 18px",
        height: 56,
        background: "var(--ink)",
        color: "var(--ink-text)",
        borderBottom: "1px solid var(--ink-border)",
        boxShadow: "0 1px 0 rgba(0,0,0,0.35), 0 8px 24px -12px rgba(0,0,0,0.5)",
        position: "sticky",
        top: 0,
        zIndex: 50,
      }}
    >
      <Link
        href="/"
        className="tb-brand"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 11,
          minWidth: 0,
          color: "var(--ink-text)",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 24,
            height: 24,
            borderRadius: 7,
            flexShrink: 0,
            display: "grid",
            placeItems: "center",
            background: "linear-gradient(150deg, var(--brand) 0%, #7c6ff0 100%)",
            boxShadow: "0 0 0 1px rgba(255,255,255,0.12), 0 2px 8px -2px rgba(37,99,235,0.6)",
          }}
        >
          {/* snowflake mark */}
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round">
            <path d="M12 2v20M4.2 7l15.6 10M19.8 7L4.2 17" />
          </svg>
        </span>
        <span style={{ fontWeight: 600, letterSpacing: "-0.01em", fontSize: 15 }}>CoolFix</span>
        <span
          className="tb-context"
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10,
            letterSpacing: "0.06em",
            color: "var(--ink-text-muted)",
            border: "1px solid var(--ink-border)",
            borderRadius: 5,
            padding: "3px 7px",
            whiteSpace: "nowrap",
          }}
        >
          {context}
        </span>
      </Link>

      <nav
        aria-label="Switch persona"
        style={{
          display: "flex",
          gap: 3,
          background: "rgba(0,0,0,0.28)",
          border: "1px solid var(--ink-border)",
          padding: 3,
          borderRadius: 9,
          flexShrink: 0,
        }}
      >
        {PERSONAS.map((p) => {
          const isActive = p.key === active;
          return (
            <Link
              key={p.key}
              href={p.href}
              aria-current={isActive ? "page" : undefined}
              className={`tb-tab${isActive ? " is-active" : ""}`}
            >
              {p.label}
            </Link>
          );
        })}
      </nav>

      <style>{`
        .tb-brand .tb-context { transition: border-color 0.15s, color 0.15s; }
        .tb-brand:hover { text-decoration: none; }
        .tb-brand:hover .tb-context {
          border-color: var(--ink-text-faint);
          color: var(--ink-text);
        }
        .tb-tab {
          font-size: 12.5px;
          font-weight: 400;
          line-height: 1;
          color: var(--ink-text-muted);
          background: transparent;
          border-radius: 6px;
          padding: 7px 13px;
          transition: color 0.15s, background 0.15s;
        }
        .tb-tab:hover {
          color: var(--ink-text);
          background: rgba(255,255,255,0.06);
          text-decoration: none;
        }
        .tb-tab.is-active {
          color: var(--ink-text);
          font-weight: 500;
          background: linear-gradient(180deg, #38355a 0%, #2a2846 100%);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.07), 0 1px 2px rgba(0,0,0,0.3);
        }
        .tb-tab.is-active:hover { background: linear-gradient(180deg, #3e3b63 0%, #302d4e 100%); }
        @media (max-width: 560px) {
          .tb-context { display: none; }
        }
      `}</style>
    </header>
  );
}
