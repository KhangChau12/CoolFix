// Repository regressions through the real Supabase client with mocked HTTP.
// No live database access. Run: npx tsx scripts/repoUnit.ts
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/lib/types";
import { configToRow } from "../src/lib/mappers";

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://repo-test.invalid";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service";
  let stored = configToRow(DEFAULT_CONFIG);
  let missing = new Set<string>();
  let attempts: Record<string, unknown>[] = [];
  let pages = 0;
  let tableError: string | null = null;
  const customTime = "2026-09-24T00:00:00.000Z";
  const rows = Array.from({ length: 1207 }, (_, i) => ({
    job_id: `job_${String(i).padStart(4, "0")}`,
    feedback_id: `feedback_${i}`,
    scheduled_time: customTime, freeze_point: customTime, created_at: customTime,
    rating: 5,
  }));
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.hostname, "repo-test.invalid", "Tests must never call the live database");
    assert.equal(init?.cache, "no-store");
    if (url.pathname.endsWith("/agent_decision_log")) {
      const recent = Array.from({ length: 300 }, (_, i) => ({ log_id: `recent_${i}`, job_id: "recent-job", timestamp: customTime }));
      const history = [...recent, { log_id: "older_1", job_id: "older-job", timestamp: customTime }];
      const filter = url.searchParams.get("job_id")?.replace(/^eq\./, "");
      return Response.json(history.filter((row) => !filter || row.job_id === filter)
        .slice(0, Number(url.searchParams.get("limit") ?? 200)));
    }
    if (url.pathname.endsWith("/runtime_config")) {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        attempts.push(body);
        const absent = Object.keys(body).find((key) => missing.has(key));
        if (absent) return Response.json({ code: "PGRST204", message: `Could not find the '${absent}' column of 'runtime_config' in the schema cache` }, { status: 400 });
        stored = { ...stored, ...body };
        return new Response(null, { status: 201 });
      }
      return Response.json([stored]);
    }
    pages++;
    if (tableError) return Response.json({ code: tableError, message: "table read failed" }, { status: 404 });
    const offset = Number(url.searchParams.get("offset") ?? 0);
    // A custom server cap lower than our requested page size must work too.
    const limit = Math.min(137, Number(url.searchParams.get("limit") ?? 1000));
    const batch = rows.slice(offset, offset + limit);
    return Response.json(batch, {
      headers: { "content-range": `${offset}-${offset + batch.length - 1}/${rows.length}` },
    });
  };
  const repo = await import("../src/lib/repo");

  const jobs = await repo.listJobs();
  assert.equal(jobs.length, 1207);
  assert.equal(new Set(jobs.map((job) => job.job_id)).size, 1207);
  assert.ok(pages > 1);
  assert.equal((await repo.listFeedback()).length, 1207);
  tableError = "PGRST205";
  assert.deepEqual(await repo.listFeedback(), []);
  tableError = "42501";
  await assert.rejects(repo.listFeedback(), /42501/);
  tableError = null;
  console.log("ok: complete paginated reads, lowered server cap, optional table errors");
  const history = await repo.listDecisions(200, "older-job");
  assert.equal(history.length, 1, "Job replay filters before the global feed limit");
  assert.equal(history[0].log_id, "older_1");
  console.log("ok: older job replay survives newer jobs' decision traffic");

  const adaptiveColumns = Object.keys(stored).filter((key) => key.startsWith("adaptive_") || key === "policy_version");
  missing = new Set(["clock_mode", "custom_time_iso", ...adaptiveColumns]);
  for (const key of missing) delete stored[key];
  stored.dispatch_policy = { ...DEFAULT_CONFIG.dispatchPolicy, _coolfix_clock: { clockMode: "custom", customTimeISO: customTime } };
  const updated = await repo.updateConfig({ ...DEFAULT_CONFIG, clockMode: "custom", customTimeISO: customTime });
  assert.equal(updated.clockMode, "real");
  assert.equal(updated.customTimeISO, null);
  assert.deepEqual((stored.dispatch_policy as Record<string, unknown>)._coolfix_clock, { clockMode: "real", customTimeISO: null });
  assert.equal(attempts.length, 3, "Both missing migration groups must be removed");
  attempts = [];
  const nextTime = "2026-09-25T00:00:00.000Z";
  const clockOnly = await repo.updateConfig({ customTimeISO: nextTime });
  assert.equal(clockOnly.clockMode, "real", "Old clients cannot restore a simulated clock");
  assert.equal(clockOnly.customTimeISO, null);
  const policyOnly = await repo.updateConfig({ dispatchPolicy: DEFAULT_CONFIG.dispatchPolicy });
  assert.equal(policyOnly.clockMode, "real", "Updating policy keeps the real clock");
  assert.equal(policyOnly.customTimeISO, null);
  console.log("ok: databases missing both clock/adaptive columns, partial clock updates, policy updates");

  missing = new Set(["clock_mode", "custom_time_iso"]);
  stored.policy_version = "policy-v7";
  attempts = [];
  await repo.updateConfig({ clockMode: "real", policyVersion: "browser-forged-version" });
  assert.equal(stored.policy_version, "policy-v7");
  assert.ok(attempts.every((attempt) => attempt.policy_version === undefined));
  await repo.updateConfig({ dispatchPolicy: DEFAULT_CONFIG.dispatchPolicy });
  assert.equal(stored.policy_version, "policy-v8", "Fallback must preserve server-owned version increment");
  console.log("ok: fallback keeps policy versions server-owned");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
