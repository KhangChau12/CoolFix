"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiSend } from "@/lib/client";
import { Toast } from "@/components/ui";
import { TopBar } from "@/components/TopBar";
import type { RuntimeConfig } from "@/lib/types";

const NAV = [
  { href: "/admin", label: "Dashboard", icon: "◱" },
  { href: "/admin/flow", label: "Agent Flow Map", icon: "⛓" },
  { href: "/admin/schedule", label: "Schedule", icon: "▤" },
  { href: "/admin/queue", label: "Job Queue", icon: "≡" },
  { href: "/admin/technicians", label: "Technicians", icon: "⚉" },
  { href: "/admin/approvals", label: "Approvals (HITL)", icon: "✔", badgeKey: "approvals" },
  { href: "/admin/settings", label: "Settings", icon: "⚙" },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const [freezeHours, setFreezeHours] = useState<number | null>(null);
  const [toast, setToast] = useState<{ msg: string; kind: "info" | "success" | "error" } | null>(
    null,
  );

  const refreshBadges = useCallback(async () => {
    try {
      const { approvals } = await apiGet<{ approvals: { status: string }[] }>("/api/approvals");
      setPendingApprovals(approvals.filter((a) => a.status === "pending").length);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    refreshBadges();
    const t = setInterval(refreshBadges, 4000);
    return () => clearInterval(t);
  }, [refreshBadges, pathname]);

  useEffect(() => {
    apiGet<{ config: RuntimeConfig }>("/api/config")
      .then(({ config }) => setFreezeHours(config.freezeWindowHours))
      .catch(() => {
        /* ignore */
      });
  }, []);

  async function resetDemo() {
    if (!confirm("Reset all data to the initial demo state?")) return;
    try {
      const r = await apiSend<{ message: string }>("/api/reset", "POST");
      setToast({ msg: r.message, kind: "success" });
      setTimeout(() => location.reload(), 700);
    } catch (e) {
      setToast({ msg: (e as Error).message, kind: "error" });
    }
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
      <TopBar active="admin" context="DISPATCH CONSOLE · SG" />
      <div style={{ display: "flex", minHeight: "calc(100vh - 54px)" }}>
        <aside
          style={{
            width: 200,
            flex: "none",
            background: "var(--surface-2)",
            borderRight: "1px solid var(--border)",
            padding: "14px 10px",
            display: "flex",
            flexDirection: "column",
            gap: 2,
            position: "sticky",
            top: 54,
            height: "calc(100vh - 54px)",
          }}
        >
          <div
            style={{
              fontFamily: "var(--mono)",
              fontSize: 10,
              letterSpacing: "0.08em",
              color: "var(--text-faint)",
              padding: "6px 10px 8px",
            }}
          >
            OPERATIONS
          </div>

          {NAV.map((n) => {
            const active = pathname === n.href || (n.href !== "/admin" && pathname.startsWith(n.href));
            return (
              <Link
                key={n.href}
                href={n.href}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  padding: "9px 10px",
                  borderRadius: 7,
                  color: active ? "var(--text)" : "var(--text-muted)",
                  background: active ? "#e6e3dd" : "transparent",
                  fontWeight: active ? 600 : 400,
                  fontSize: 13,
                }}
              >
                <span style={{ width: 16, textAlign: "center", opacity: 0.8 }}>{n.icon}</span>
                {n.label}
                {n.badgeKey === "approvals" && pendingApprovals > 0 && (
                  <span className="pill-count" style={{ marginLeft: "auto" }}>
                    {pendingApprovals}
                  </span>
                )}
              </Link>
            );
          })}

          <div
            style={{
              marginTop: "auto",
              padding: "12px 10px 4px",
              borderTop: "1px solid var(--border)",
            }}
          >
            <div style={{ fontSize: 11.5, color: "var(--text-faint)" }}>Freeze window</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 16, marginTop: 2 }}>
              {freezeHours == null ? "—" : `T − ${freezeHours}h 00m`}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-faint)", lineHeight: 1.45, marginTop: 6 }}>
              Jobs inside this window cannot be re-planned automatically.
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
            <button className="btn btn-ghost" style={{ justifyContent: "flex-start" }} onClick={resetDemo}>
              ↺ Reset demo data
            </button>
            <Link
              href="/api/health"
              prefetch={false}
              className="faint"
              style={{ fontSize: 11, padding: "0 10px" }}
            >
              system health →
            </Link>
          </div>
        </aside>

        <main style={{ flex: 1, minWidth: 0, padding: "22px 26px 56px" }}>{children}</main>
      </div>

      {toast && <Toast message={toast.msg} kind={toast.kind} onClose={() => setToast(null)} />}
    </div>
  );
}
