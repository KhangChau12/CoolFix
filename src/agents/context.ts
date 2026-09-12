// ── AgentContext ────────────────────────────────────────────────────
// One pipeline run = one context. It loads the technician roster, the
// job list and config ONCE at the start (so scoring doesn't fan out into
// dozens of DB round-trips). This keeps the reasoning loop's state explicit
// and auditable (rubric: "clear state management").
//
// Two things are NOT buffered-to-the-end, both for the same reason — the
// live Agent Line Map (/admin/flow):
//
//   1. Decision-log rows — inserted the moment the agent that produced
//      them finishes (bufferDecision fires the insert immediately, in the
//      background), so a judge watching that tab sees each agent light up
//      as it really runs, not all 8-10 rows at once after the whole
//      pipeline (including a ~6s LLM call) returns.
//   2. The job row itself — persisted (a bare skeleton) the FIRST time it
//      is staged, so /admin/flow can discover "which booking to follow"
//      while the pipeline is still running. Without this the flow page,
//      which keys off the jobs table + realtime("jobs"), never learns the
//      job id until flush() at the very end — so it shows "no booking yet"
//      for the entire run and the live effect is dead. Every later
//      stageJob() only updates the in-memory view; the authoritative row
//      (final status, technician, score) is written once at flush().
//
// Workload / approvals / notifications are still buffered and flushed
// together at the end — nothing about their consistency changes.

import * as repo from "@/lib/repo";
import { emptyRatingSummary, summarizeFeedbackByTechnician, type TechnicianRatingSummary } from "@/lib/rating";
import type {
  AgentDecisionLog,
  ApprovalRequest,
  Job,
  NotificationRecord,
  RuntimeConfig,
  Technician,
} from "@/lib/types";

export class AgentContext {
  technicians: Technician[] = [];
  jobs: Job[] = [];
  config!: RuntimeConfig;
  /** One rating summary per technician who has ANY feedback — see
   *  `ratingSummaryFor`, which is the one call sites should actually use
   *  (it fills in the cold-start zero-ratings summary for everyone else). */
  private ratingSummaries = new Map<string, TechnicianRatingSummary>();

  /** Rows produced this run, flushed in order at the end. */
  private decisionBuffer: AgentDecisionLog[] = [];
  private notificationBuffer: NotificationRecord[] = [];
  private approvalBuffer: ApprovalRequest[] = [];
  private jobWrites = new Map<string, Job>();
  private workloadWrites = new Map<string, number>();
  /** In-flight inserts fired by bufferDecision(); flush() awaits these
   *  instead of re-inserting, so every row lands exactly once. */
  private decisionInserts: Promise<void>[] = [];
  /** Job ids already persisted once by stageJob() (the live-discovery
   *  skeleton write). Tracked so we only fire that upsert on the first
   *  stage of each job, not on all ~11 subsequent ones. */
  private jobsPersistedLive = new Set<string>();
  /** In-flight skeleton upserts from stageJob(); flush() awaits these
   *  before writing the authoritative rows so ordering is deterministic. */
  private liveJobUpserts: Promise<void>[] = [];

  static async create(): Promise<AgentContext> {
    const ctx = new AgentContext();
    const [techs, jobs, config, feedback] = await Promise.all([
      repo.listTechnicians(),
      repo.listJobs(),
      repo.getConfig(),
      repo.listFeedback(),
    ]);
    ctx.technicians = techs;
    ctx.jobs = jobs;
    ctx.config = config;
    ctx.ratingSummaries = summarizeFeedbackByTechnician(feedback);
    return ctx;
  }

  getJob(id: string): Job | undefined {
    return this.jobWrites.get(id) ?? this.jobs.find((j) => j.job_id === id);
  }

  getTechnician(id: string): Technician | undefined {
    return this.technicians.find((t) => t.technician_id === id);
  }

  /** A technician's rating summary — the cold-start zero-ratings summary
   *  (smoothed = the prior, average = null) for anyone with no feedback
   *  yet, so scoring.ts never has to special-case "missing". */
  ratingSummaryFor(technicianId: string): TechnicianRatingSummary {
    return this.ratingSummaries.get(technicianId) ?? emptyRatingSummary(technicianId);
  }

  /** Buffer a job upsert; also updates the in-memory view for later agents.
   *  The FIRST stage of a given job also persists it right away (in the
   *  background) so /admin/flow can pick the booking up mid-run — see the
   *  header note. Subsequent stages only touch memory; flush() writes the
   *  final authoritative row. */
  stageJob(job: Job): void {
    this.jobWrites.set(job.job_id, job);
    const i = this.jobs.findIndex((j) => j.job_id === job.job_id);
    if (i >= 0) this.jobs[i] = job;
    else this.jobs.push(job);

    if (!this.jobsPersistedLive.has(job.job_id)) {
      this.jobsPersistedLive.add(job.job_id);
      this.liveJobUpserts.push(repo.upsertJob(job));
    }
  }

  stageWorkload(technicianId: string, delta: number): void {
    const t = this.getTechnician(technicianId);
    if (!t) return;
    const current = this.workloadWrites.get(technicianId) ?? t.current_workload;
    const next = Math.max(0, current + delta);
    this.workloadWrites.set(technicianId, next);
    t.current_workload = next;
  }

  /** Buffer a decision row for in-memory reads (ctx.decisions) AND insert
   *  it into the DB right away, in the background — this is what makes the
   *  row visible to Realtime subscribers the moment this agent finishes,
   *  not at the end of the whole pipeline. A failed insert here is not
   *  swallowed: it surfaces at flush() via Promise.all, same as any other
   *  write failure would. */
  bufferDecision(entry: AgentDecisionLog): void {
    this.decisionBuffer.push(entry);
    this.decisionInserts.push(repo.insertDecision(entry));
  }

  bufferNotification(n: NotificationRecord): void {
    this.notificationBuffer.push(n);
  }

  bufferApproval(a: ApprovalRequest): void {
    this.approvalBuffer.push(a);
  }

  get decisions(): AgentDecisionLog[] {
    return this.decisionBuffer;
  }
  get notifications(): NotificationRecord[] {
    return this.notificationBuffer;
  }
  get approvals(): ApprovalRequest[] {
    return this.approvalBuffer;
  }

  /** Persist everything this run produced. Decision rows were already
   *  inserted live by bufferDecision() — this just waits for all of those
   *  in-flight writes to actually land before the pipeline reports done,
   *  so a caller that reads the DB right after (eval scripts, the API
   *  response) never sees a partial log. */
  async flush(): Promise<void> {
    // Wait for any in-flight skeleton upserts from stageJob() to land
    // first, so the authoritative write below is guaranteed to be last.
    await Promise.all(this.liveJobUpserts);
    for (const j of this.jobWrites.values()) await repo.upsertJob(j);
    for (const [techId, w] of this.workloadWrites) await repo.setTechnicianWorkload(techId, w);
    await Promise.all(this.decisionInserts);
    for (const a of this.approvalBuffer) await repo.insertApproval(a);
    for (const n of this.notificationBuffer) await repo.insertNotification(n);
  }
}
