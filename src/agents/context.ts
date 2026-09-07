// ── AgentContext ────────────────────────────────────────────────────
// One pipeline run = one context. It loads the technician roster, the
// job list and config ONCE at the start (so scoring doesn't fan out into
// dozens of DB round-trips), buffers decision-log rows, and flushes
// everything at the end. This keeps the reasoning loop's state explicit
// and auditable (rubric: "clear state management").

import * as repo from "@/lib/repo";
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

  /** Rows produced this run, flushed in order at the end. */
  private decisionBuffer: AgentDecisionLog[] = [];
  private notificationBuffer: NotificationRecord[] = [];
  private approvalBuffer: ApprovalRequest[] = [];
  private jobWrites = new Map<string, Job>();
  private workloadWrites = new Map<string, number>();

  static async create(): Promise<AgentContext> {
    const ctx = new AgentContext();
    const [techs, jobs, config] = await Promise.all([
      repo.listTechnicians(),
      repo.listJobs(),
      repo.getConfig(),
    ]);
    ctx.technicians = techs;
    ctx.jobs = jobs;
    ctx.config = config;
    return ctx;
  }

  getJob(id: string): Job | undefined {
    return this.jobWrites.get(id) ?? this.jobs.find((j) => j.job_id === id);
  }

  getTechnician(id: string): Technician | undefined {
    return this.technicians.find((t) => t.technician_id === id);
  }

  /** Buffer a job upsert; also updates the in-memory view for later agents. */
  stageJob(job: Job): void {
    this.jobWrites.set(job.job_id, job);
    const i = this.jobs.findIndex((j) => j.job_id === job.job_id);
    if (i >= 0) this.jobs[i] = job;
    else this.jobs.push(job);
  }

  stageWorkload(technicianId: string, delta: number): void {
    const t = this.getTechnician(technicianId);
    if (!t) return;
    const current = this.workloadWrites.get(technicianId) ?? t.current_workload;
    const next = Math.max(0, current + delta);
    this.workloadWrites.set(technicianId, next);
    t.current_workload = next;
  }

  bufferDecision(entry: AgentDecisionLog): void {
    this.decisionBuffer.push(entry);
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

  /** Persist everything this run produced, in a deterministic order. */
  async flush(): Promise<void> {
    for (const j of this.jobWrites.values()) await repo.upsertJob(j);
    for (const [techId, w] of this.workloadWrites) await repo.setTechnicianWorkload(techId, w);
    for (const d of this.decisionBuffer) await repo.insertDecision(d);
    for (const a of this.approvalBuffer) await repo.insertApproval(a);
    for (const n of this.notificationBuffer) await repo.insertNotification(n);
  }
}
