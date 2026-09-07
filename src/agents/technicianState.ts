// ── Technician-State Agent ──────────────────────────────────────────
// NO LLM. Pure state store / DB query (CLAUDE.md §4).
// Returns the roster of technicians who *could* take a job, with the
// facts scoring needs. It applies only objective time filters here; the
// skill hard-constraint and soft scoring belong to the Assignment Agent
// so the whole candidate set (including rejects) is visible in the feed.

import { nowISO } from "@/lib/time";
import { logDecision } from "./log";
import type { TechCandidate, TechStateResult } from "./schemas";
import type { AgentContext } from "./context";

function withinWorkingHours(
  scheduledISO: string,
  wh: { start: string; end: string },
): boolean {
  const local = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(scheduledISO));
  const [h, m] = local.split(":").map(Number);
  const mins = h * 60 + m;
  const [sh, sm] = wh.start.split(":").map(Number);
  const [eh, em] = wh.end.split(":").map(Number);
  return mins >= sh * 60 + sm && mins <= eh * 60 + em;
}

export function runTechnicianStateAgent(
  ctx: AgentContext,
  args: { jobId: string; scheduledTime: string },
): TechStateResult {
  const techs = ctx.technicians;

  const candidates: TechCandidate[] = techs.map((t) => ({
    technician_id: t.technician_id,
    name: t.name,
    skill_tags: t.skill_tags,
    experience_level: t.experience_level,
    location: t.location,
    current_workload: t.current_workload,
    within_working_hours: withinWorkingHours(args.scheduledTime, t.working_hours),
  }));

  const result: TechStateResult = { candidates, as_of: nowISO() };

  logDecision(ctx, {
    agent: "TechnicianStateAgent",
    jobId: args.jobId,
    reasoningKind: "rule",
    input: { scheduled_time: args.scheduledTime, roster_size: techs.length },
    output: {
      candidate_count: candidates.length,
      within_hours: candidates.filter((c) => c.within_working_hours).length,
    },
    headline: `Provided ${candidates.length} technicians (${
      candidates.filter((c) => c.within_working_hours).length
    } within working hours)`,
    outcome: "info",
    guardrailNotes: [
      "Pure state store — no LLM call (deliberate architecture decision).",
      "Least-privilege: returns only the fields scoring needs; technician phone / home address are not exposed.",
    ],
  });

  return result;
}
