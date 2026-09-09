import Link from "next/link";

// Landing / persona picker. Not part of the product surface — just a
// convenient entry point for the demo into the three interfaces.

const CARDS = [
  {
    href: "/admin",
    tag: "COORDINATOR",
    emoji: "🖥️",
    title: "Company",
    sub: "Dispatch dashboard — live Agent Reasoning Feed, master schedule, HITL approvals. The primary demo surface.",
    accent: "#2563eb",
  },
  {
    href: "/book",
    tag: "PUBLIC",
    emoji: "📝",
    title: "Customer",
    sub: "Aircon servicing booking form. Pick a response tier, describe the problem, track the status live.",
    accent: "#16a34a",
  },
  {
    href: "/tech",
    tag: "MOBILE",
    emoji: "📱",
    title: "Technician",
    sub: "The technician's personal schedule app. Receive jobs, acknowledge notifications, update from the field.",
    accent: "#e07a1f",
  },
];

const PIPELINE = [
  { name: "Job-Intake", kind: "LLM", color: "var(--agent-intake)" },
  { name: "Pricing", kind: "RULE", color: "var(--agent-pricing)" },
  { name: "Capacity", kind: "RULE", color: "var(--agent-capacity)" },
  { name: "Tech-State", kind: "RULE", color: "var(--agent-techstate)" },
  { name: "Assignment", kind: "LLM/RULE", color: "var(--agent-assignment)" },
  { name: "Disruption", kind: "LLM", color: "var(--agent-disruption)" },
  { name: "Notification", kind: "LLM", color: "#77736d" },
];

export default function Home() {
  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 11,
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
        <span
          aria-hidden
          style={{
            width: 24,
            height: 24,
            borderRadius: 7,
            display: "grid",
            placeItems: "center",
            background: "linear-gradient(150deg, var(--brand) 0%, #4f46e5 100%)",
            boxShadow: "0 0 0 1px rgba(255,255,255,0.12), 0 2px 8px -2px rgba(37,99,235,0.6)",
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round">
            <path d="M12 2v20M4.2 7l15.6 10M19.8 7L4.2 17" />
          </svg>
        </span>
        <strong style={{ fontWeight: 600, letterSpacing: "-0.01em", fontSize: 15 }}>CoolFix</strong>
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10,
            letterSpacing: "0.06em",
            color: "var(--ink-text-muted)",
            border: "1px solid var(--ink-border)",
            borderRadius: 5,
            padding: "3px 7px",
          }}
        >
          SHOW ME YOUR AGENTS · NUS ISS
        </span>
      </header>

      <main className="container" style={{ maxWidth: 980, paddingTop: 56, paddingBottom: 64 }}>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 11.5,
            fontFamily: "var(--mono)",
            color: "var(--text-muted)",
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: 20,
            padding: "5px 12px",
            marginBottom: 20,
          }}
        >
          <span className="live-dot" style={{ width: 6, height: 6 }} />
          7-agent pipeline · human-in-the-loop · Singapore aircon dispatch
        </div>

        <h1
          style={{
            fontSize: 44,
            lineHeight: 1.08,
            letterSpacing: "-0.03em",
            fontWeight: 600,
            margin: 0,
            maxWidth: 720,
          }}
        >
          Multi-agent dispatch for aircon technicians.
        </h1>
        <p
          className="muted"
          style={{ fontSize: 15.5, lineHeight: 1.65, marginTop: 16, maxWidth: 620 }}
        >
          Customer bookings flow through intake, pricing, capacity and scoring
          agents that auto-assign a certified technician — and stop for a
          coordinator's approval the moment a re-plan would touch a real
          customer or a locked appointment.
        </p>

        {/* pipeline strip */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 0,
            flexWrap: "wrap",
            marginTop: 28,
            background: "var(--ink-3)",
            border: "1px solid var(--ink-border)",
            borderRadius: 10,
            padding: "12px 14px",
          }}
        >
          {PIPELINE.map((p, i) => (
            <div key={p.name} style={{ display: "flex", alignItems: "center" }}>
              <span
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 11,
                  color: "var(--ink-text)",
                  whiteSpace: "nowrap",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <span style={{ width: 6, height: 6, borderRadius: 999, background: p.color, flexShrink: 0 }} />
                {p.name}
                <span style={{ color: "var(--ink-text-faint)", fontSize: 9 }}>{p.kind}</span>
              </span>
              {i < PIPELINE.length - 1 && (
                <span style={{ color: "var(--ink-text-faint)", margin: "0 10px", fontSize: 11 }}>→</span>
              )}
            </div>
          ))}
        </div>

        {/* persona cards */}
        <div
          className="grid"
          style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", marginTop: 32, gap: 12 }}
        >
          {CARDS.map((c) => (
            <Link
              key={c.href}
              href={c.href}
              style={{
                display: "block",
                color: "inherit",
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 12,
                padding: "20px 20px 22px",
                boxShadow: "var(--shadow-sm)",
              }}
            >
              <div style={{ width: 5, borderRadius: 3, background: c.accent, height: 24, marginBottom: 14 }} />
              <div className="row" style={{ gap: 9, marginBottom: 2 }}>
                <span style={{ fontSize: 20 }}>{c.emoji}</span>
                <span
                  className="mono"
                  style={{
                    fontSize: 10,
                    letterSpacing: "0.06em",
                    color: c.accent,
                    fontWeight: 600,
                  }}
                >
                  {c.tag}
                </span>
              </div>
              <h3 style={{ marginTop: 8, marginBottom: 6, fontSize: 17 }}>{c.title}</h3>
              <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.55 }}>
                {c.sub}
              </p>
              <div
                className="mono"
                style={{ marginTop: 14, fontSize: 11.5, color: c.accent, fontWeight: 600 }}
              >
                Open →
              </div>
            </Link>
          ))}
        </div>

        <div
          className="row"
          style={{
            justifyContent: "space-between",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            padding: "16px 18px",
            marginTop: 14,
            flexWrap: "wrap",
            gap: 12,
          }}
        >
          <div>
            <strong style={{ fontSize: 13.5 }}>System status</strong>
            <p className="muted" style={{ margin: "3px 0 0", fontSize: 12.5 }}>
              Check the Supabase connection, LLM mode, and data counts.
            </p>
          </div>
          <Link className="btn" href="/api/health" prefetch={false}>
            /api/health
          </Link>
        </div>
      </main>
    </div>
  );
}
