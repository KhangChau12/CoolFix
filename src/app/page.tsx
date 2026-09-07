import Link from "next/link";

// Landing / persona picker. Not part of the product surface — just a
// convenient entry point for the demo into the three interfaces.

const CARDS = [
  {
    href: "/admin",
    emoji: "🖥️",
    title: "Coordinator / Admin",
    sub: "Dispatch dashboard — Agent Reasoning Feed, master schedule, HITL. The primary demo surface.",
    accent: "var(--brand)",
  },
  {
    href: "/book",
    emoji: "📝",
    title: "Customer",
    sub: "Aircon servicing booking form. Pick a tier, describe the problem, track the status.",
    accent: "var(--tier-standard)",
  },
  {
    href: "/tech",
    emoji: "📱",
    title: "Technician",
    sub: "The technician's personal schedule app. Receive jobs, acknowledge notifications, update from the field.",
    accent: "var(--tier-flexible)",
  },
];

export default function Home() {
  return (
    <main className="container" style={{ paddingTop: 64, paddingBottom: 64, maxWidth: 960 }}>
      <div className="row" style={{ gap: 10, marginBottom: 8 }}>
        <span style={{ fontSize: 30 }}>❄️</span>
        <h1 style={{ fontSize: 30, margin: 0 }}>CoolFix</h1>
      </div>
      <p className="muted" style={{ fontSize: 16, marginTop: 0, maxWidth: 640 }}>
        A <strong>multi-agent system</strong> that automatically dispatches aircon-servicing
        technicians and handles schedule disruptions — with explainable decisions and
        human approval gates calibrated to risk.
      </p>

      <div
        className="grid"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", marginTop: 32 }}
      >
        {CARDS.map((c) => (
          <Link
            key={c.href}
            href={c.href}
            className="card"
            style={{ padding: 22, display: "block", color: "inherit" }}
          >
            <div
              style={{
                fontSize: 26,
                width: 48,
                height: 48,
                borderRadius: 12,
                display: "grid",
                placeItems: "center",
                background: "var(--surface-2)",
                border: `1px solid var(--border)`,
                borderLeft: `3px solid ${c.accent}`,
              }}
            >
              {c.emoji}
            </div>
            <h3 style={{ marginTop: 14, marginBottom: 6 }}>{c.title}</h3>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              {c.sub}
            </p>
          </Link>
        ))}
      </div>

      <div className="card" style={{ padding: 18, marginTop: 28 }}>
        <div className="spread">
          <div>
            <strong>System status</strong>
            <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
              Check the Supabase connection, LLM mode, and data counts.
            </p>
          </div>
          <Link className="btn" href="/api/health" prefetch={false}>
            /api/health
          </Link>
        </div>
      </div>
    </main>
  );
}
