// Display regressions, with no live database or network access.
import assert from "node:assert/strict";
import { compareDecisions, computeFlow, sortPipelineOrder } from "../src/lib/flowMap";
import { createLiveRefresh } from "../src/lib/liveRefresh";
import type { AgentDecisionLog } from "../src/lib/types";

const timestamp = "2026-09-24T00:00:00.000Z";
function row(seq: number, agent: AgentDecisionLog["agent_name"], patch: Partial<AgentDecisionLog> = {}): AgentDecisionLog {
  return {
    log_id: `log_${(1800000000000 + seq).toString(36)}_${seq.toString(36)}`,
    timestamp, agent_name: agent, job_id: "test-job", reasoning_kind: "rule",
    input_summary: {}, output_summary: {}, score_breakdown: null, candidates: null,
    replan_options: null, requires_human_approval: false, outcome: "info",
    approved_by: null, headline: agent, latency_ms: 0, guardrail_notes: [], ...patch,
  };
}

const paused = [
  row(1, "Orchestrator", { output_summary: { pipeline: "start" } }),
  row(2, "JobIntakeAgent"), row(3, "PricingEngine"), row(4, "CapacityAgent"),
  row(5, "AssignmentAgent"),
  row(6, "DisruptionAgent", { requires_human_approval: true, outcome: "requires_approval" }),
  row(7, "Orchestrator", { requires_human_approval: true, outcome: "requires_approval" }),
];
// Approval runs on another worker: its sequence restarts, its demo time does not.
const approved = row(8, "Orchestrator", {
  log_id: `log_${(1800000000008).toString(36)}_1`,
  outcome: "approved", output_summary: { result: "replan_approved" },
});
const resolved = [...paused, approved, row(9, "NotificationAgent"), row(10, "NotificationAgent")];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function main() {
  const order = sortPipelineOrder([...resolved].reverse());
  assert.deepEqual(order.map((r) => r.log_id), resolved.map((r) => r.log_id));
  assert.equal(compareDecisions(row(2, "CapacityAgent", { timestamp: "2026-09-24T00:00:00+00:00" }), row(2, "CapacityAgent")), 0);
  assert.equal(computeFlow(paused).stations.hitl.state, "halt");

  const flow = computeFlow(resolved);
  assert.equal(flow.haltedForHuman, false, "Approved gates must stop showing a human hold");
  assert.equal(flow.stations.hitl.state, "done");
  assert.equal(flow.stations.notify.visits.length, 2);
  assert.deepEqual(flow.steps.map((step) => step.to), ["orch", "intake", "price", "cap", "assign", "disrupt", "hitl", "hitl", "notify", "notify"]);
  // Every prefix is exactly the state the animation reveals. Approval and
  // repeated notifications must never disappear while another hop is queued.
  for (let count = 0; count <= flow.steps.length; count++) {
    const prefix = computeFlow(flow.steps.slice(0, count).map((step) => step.row));
    assert.equal(prefix.steps.length, count);
    if (count >= 8) assert.equal(prefix.haltedForHuman, false);
    if (count < 9) {
      assert.equal(prefix.stations.notify.visits.length, 0);
      assert.equal(prefix.stations.notify.state, "pending");
    }
  }

  const patchedHistory = paused.map((r) => r.agent_name === "DisruptionAgent" ? { ...r, outcome: "approved" as const } : r);
  assert.equal(computeFlow(patchedHistory).stations.hitl.state, "halt", "Historical edits cannot skip the resolution event");
  assert.equal(computeFlow([...patchedHistory, approved]).stations.hitl.state, "done");
  assert.equal(computeFlow([...paused, { ...approved, outcome: "rejected" }]).haltedForHuman, true);
  assert.equal(computeFlow([...paused, { ...approved, output_summary: { result: "proposal_acknowledged" } }]).haltedForHuman, true);

  const auto = [row(1, "AssignmentAgent"), row(2, "Orchestrator", { outcome: "auto_commit" }), row(3, "NotificationAgent")];
  assert.equal(computeFlow(auto).steps.length, 3);
  assert.equal(computeFlow(auto).stations.notify.state, "done");
  assert.equal(computeFlow([...auto, row(4, "DisruptionAgent")]).stations.disrupt.state, "active", "Later disruptions must restart activity");
  assert.equal(computeFlow([paused[5]]).stations.disrupt.state, "halt", "Disruptions without an Orchestrator gate still show a hold");

  const requests: ReturnType<typeof deferred<number>>[] = [];
  const commits: number[] = [];
  const refresh = createLiveRefresh(() => {
    const request = deferred<number>();
    requests.push(request);
    return request.promise;
  }, (data) => commits.push(data));
  const running = refresh.refresh();
  void refresh.refresh();
  void refresh.refresh();
  assert.equal(requests.length, 1, "Refresh bursts must not start overlapping requests");
  requests[0].resolve(1);
  await tick();
  assert.equal(requests.length, 2, "Events during a request must trigger a follow-up");
  requests[1].resolve(2);
  await running;
  assert.deepEqual(commits, [1, 2]);
  const failed = refresh.refresh();
  requests[2].reject(new Error("temporary failure"));
  await failed;
  assert.deepEqual(commits, [1, 2], "Errors retain the last snapshot");
  const oldJob = refresh.refresh();
  refresh.dispose();
  requests[3].resolve(3);
  await oldJob;
  assert.deepEqual(commits, [1, 2], "Unmounted jobs cannot commit delayed responses");

  // Deliberately hold the first insert: later agents must not become
  // visible first, even when their computation has already finished.
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://flow-test.invalid";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test";
  const inserted: string[] = [];
  const release = deferred<void>();
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.hostname, "flow-test.invalid");
    assert.equal(url.pathname, "/rest/v1/agent_decision_log");
    inserted.push(JSON.parse(String(init?.body)).log_id);
    if (inserted.length === 1) await release.promise;
    return new Response(null, { status: 201 });
  };
  const { AgentContext } = await import("../src/agents/context");
  const ctx = new AgentContext();
  paused.slice(0, 3).forEach((r) => ctx.bufferDecision(r));
  await tick();
  assert.deepEqual(inserted, [paused[0].log_id]);
  release.resolve();
  await ctx.flush();
  assert.deepEqual(inserted, paused.slice(0, 3).map((r) => r.log_id));
  console.log("Flow display regressions passed: ordering, approval/rejection, replay prefixes, refresh races, and live insert order.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
