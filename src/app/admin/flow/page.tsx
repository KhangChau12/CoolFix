"use client";

// ── Admin · Agent Flow Map ──────────────────────────────────────────
// Built to run in a second window next to /book during a demo: submit a
// booking there, and this tab picks it up automatically (no job id to
// type) and animates the pipeline live as each agent actually runs.
//
// "Latest booking" means the most recently CREATED job, not the most
// recently touched one — so approving something old in another tab never
// steals focus away from the booking someone is watching right now.
// Auto-follow can be pinned to a specific job (via ?job=<id>, or the
// picker below) for a stable link, e.g. to walk a judge through one
// booking after the fact.

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiGet } from "@/lib/client";
import { useRealtime } from "@/components/useRealtime";
import { AgentFlowMap } from "@/components/AgentFlowMap";
import { TierBadge, StatusDot } from "@/components/ui";
import { seqOf } from "@/lib/flowMap";
import type { AgentDecisionLog, Job, Tier } from "@/lib/types";

export default function AgentFlowPage() {
  return (
    <Suspense fallback={null}>
      <AgentFlowPageInner />
    </Suspense>
  );
}

type LogStub = { jobId: string; customer: string | null; tier: Tier | null };

/** Build the header stand-in shown while a booking's full job record is
 *  still mid-flush — customer + tier come from its first decision row. */
function stubFromRow(jobId: string, firstRow: AgentDecisionLog): LogStub {
  return {
    jobId,
    customer: (firstRow.input_summary?.customer_name as string | undefined) ?? null,
    tier: (firstRow.input_summary?.tier as Tier | undefined) ?? null,
  };
}

function AgentFlowPageInner() {
  const router = useRouter();
  const params = useSearchParams();
  const pinnedJobId = params.get("job");

  const [jobs, setJobs] = useState<Job[]>([]);
  // A lightweight header stand-in for a booking that has decision rows in
  // the log but whose full job record hasn't flushed yet (customer/tier
  // come from the Orchestrator "New booking received" row).
  const [logStub, setLogStub] = useState<LogStub | null>(null);
  const [followId, setFollowId] = useState<string | null>(pinnedJobId);
  const followingLatest = !pinnedJobId;
  // The newest job id we've already adopted — so a burst of polls doesn't
  // keep "re-discovering" the same booking.
  const adoptedNewest = useRef<string | null>(null);

  // Discovery runs off the agent_decision_log, NOT the jobs table: a
  // decision row lands the instant its agent finishes (see
  // agents/context.ts), whereas the jobs row — before the skeleton write
  // that stageJob() now does — only appeared at the very end of the run.
  // Keying off the log is what lets this page pick a booking up while the
  // pipeline is still on its first agent. The jobs list is loaded too, but
  // only to enrich the header and populate the picker.
  const load = useCallback(async () => {
    try {
      const [{ decisions }, jobsRes] = await Promise.all([
        apiGet<{ decisions: AgentDecisionLog[] }>("/api/decisions?limit=120"),
        apiGet<{ jobs: Job[] }>("/api/bookings").catch(() => ({ jobs: [] as Job[] })),
      ]);

      const sortedJobs = jobsRes.jobs
        .slice()
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      setJobs(sortedJobs);

      // Newest booking = the job whose FIRST decision row is the most
      // recent. (First row per job ≈ the Orchestrator start row, so its
      // timestamp/seq is the booking's arrival order.)
      const firstRowByJob = new Map<string, AgentDecisionLog>();
      for (const d of decisions) {
        const cur = firstRowByJob.get(d.job_id);
        if (!cur || d.timestamp < cur.timestamp || (d.timestamp === cur.timestamp && seqOf(d.log_id) < seqOf(cur.log_id))) {
          firstRowByJob.set(d.job_id, d);
        }
      }
      const newestEntry = [...firstRowByJob.entries()].sort(
        ([, a], [, b]) => b.timestamp.localeCompare(a.timestamp) || seqOf(b.log_id) - seqOf(a.log_id),
      )[0];

      if (followingLatest && newestEntry) {
        const [newestId, firstRow] = newestEntry;
        // Adopt a booking the first time we see it — the ref guards against
        // a burst of polls re-triggering the switch for the same job.
        if (adoptedNewest.current !== newestId) {
          adoptedNewest.current = newestId;
          setFollowId(newestId);
        }
        // Header stand-in until the real job record shows up.
        setLogStub(stubFromRow(newestId, firstRow));
      } else if (!followingLatest && pinnedJobId) {
        // Pinned to a specific job — still surface a header stand-in from
        // its first decision row while its full record loads.
        const first = firstRowByJob.get(pinnedJobId);
        setLogStub(first ? stubFromRow(pinnedJobId, first) : null);
      }
    } catch {
      /* keep last */
    }
  }, [followingLatest, pinnedJobId]);

  // Subscribe to BOTH tables: decisions drive discovery, jobs refresh the
  // header the moment the full record lands.
  useRealtime("agent_decision_log", load);
  useRealtime("jobs", load);
  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setFollowId(pinnedJobId);
  }, [pinnedJobId]);

  const shownJob = jobs.find((j) => j.job_id === followId) ?? null;
  // While the pipeline is mid-run the full job record may not have flushed
  // yet — fall back to the header stand-in built from the first decision row.
  const stubForShown =
    !shownJob && logStub && logStub.jobId === followId ? logStub : null;
  const headerName =
    shownJob?.customer_name ?? stubForShown?.customer ?? (followId ? "Booking in progress" : null);

  const pickerJobs = useMemo(() => {
    const seen = new Set(jobs.map((j) => j.job_id));
    const extra =
      logStub && !seen.has(logStub.jobId)
        ? [{ job_id: logStub.jobId, customer_name: logStub.customer ?? logStub.jobId }]
        : [];
    return [...extra, ...jobs.map((j) => ({ job_id: j.job_id, customer_name: j.customer_name }))];
  }, [jobs, logStub]);

  function pinTo(id: string | null) {
    const url = id ? `/admin/flow?job=${encodeURIComponent(id)}` : "/admin/flow";
    router.push(url);
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="spread" style={{ alignItems: "flex-start" }}>
        <div>
          <h1 style={{ fontSize: 22, margin: 0 }}>Agent Flow Map</h1>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 13, maxWidth: 640 }}>
            A live line map of the reasoning pipeline. Open this next to <code className="mono">/book</code> in a
            second window — submit a booking there and it appears here automatically, with each agent lighting up
            as it actually runs.
          </p>
        </div>

        <div className="row" style={{ gap: 8, flexShrink: 0 }}>
          {!followingLatest && (
            <button className="btn" onClick={() => pinTo(null)}>
              ↺ Follow latest booking
            </button>
          )}
          <select
            value={followId ?? ""}
            onChange={(e) => pinTo(e.target.value || null)}
            className="btn"
            style={{ fontWeight: 400, minWidth: 220 }}
          >
            <option value="">— follow latest —</option>
            {pickerJobs.slice(0, 30).map((j) => (
              <option key={j.job_id} value={j.job_id}>
                {j.customer_name} · {j.job_id}
              </option>
            ))}
          </select>
        </div>
      </div>

      {(shownJob || stubForShown) && (
        <div className="card" style={{ padding: "12px 15px" }}>
          <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
            <strong style={{ fontSize: 14 }}>{headerName}</strong>
            {shownJob ? (
              <>
                <TierBadge tier={shownJob.tier} />
                <StatusDot status={shownJob.status} label />
                <span className="mono faint" style={{ fontSize: 11 }}>
                  {shownJob.location.address}
                </span>
              </>
            ) : (
              <>
                {stubForShown?.tier && <TierBadge tier={stubForShown.tier} />}
                <span
                  className="mono"
                  style={{
                    fontSize: 9.5,
                    fontWeight: 700,
                    letterSpacing: "0.04em",
                    textTransform: "uppercase",
                    color: "var(--tier-priority)",
                    background: "var(--tier-priority-bg)",
                    border: "1px solid var(--tier-priority)",
                    borderRadius: 999,
                    padding: "2px 8px",
                  }}
                >
                  pipeline running…
                </span>
              </>
            )}
            {followingLatest && (
              <span
                className="mono"
                style={{
                  marginLeft: "auto",
                  fontSize: 9.5,
                  fontWeight: 700,
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                  color: "var(--brand-ink)",
                  background: "var(--brand-tint)",
                  border: "1px solid #d3cef7",
                  borderRadius: 999,
                  padding: "2px 8px",
                }}
              >
                following latest
              </span>
            )}
            {!followingLatest && (
              <span className="mono faint" style={{ marginLeft: "auto", fontSize: 10.5 }}>
                pinned to this job
              </span>
            )}
          </div>
        </div>
      )}

      <AgentFlowMap jobId={followId} job={shownJob} />
    </div>
  );
}
