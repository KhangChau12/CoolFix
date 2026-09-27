// A recoverable, data-only showcase replacement. Run with the app stopped.
import "./_env";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildDemoDataset } from "../src/data/demoSeed";
import { buildHospitalDataset } from "../src/data/hospitalSeed";
import { serviceClient } from "../src/lib/supabase";
import { approvalToRow, configToRow, decisionToRow, feedbackToRow, jobToRow, notificationToRow, technicianToRow } from "../src/lib/mappers";

// Parent rows precede children on restore; deletion uses the reverse order.
const tables = [
  ["runtime_config", "id"], ["technicians", "technician_id"], ["jobs", "job_id"],
  ["agent_decision_log", "log_id"], ["approval_requests", "approval_id"],
  ["notifications", "notification_id"], ["job_feedback", "feedback_id"],
  ["adaptive_policy_recommendations", "recommendation_id"],
  ["adaptive_policy_change_history", "change_id"], ["feedback_submission_attempts", "attempt_id"],
] as const;
type Snapshot = { project: string; createdAt: string; tables: Record<string, Record<string, unknown>[]> };
const db = serviceClient();
const project = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).origin;

async function snapshot(): Promise<Snapshot> {
  const saved: Snapshot = { project, createdAt: new Date().toISOString(), tables: {} };
  for (const [table, key] of tables) {
    const rows: Record<string, unknown>[] = [];
    while (true) {
      const { data, error, count } = await db.from(table).select("*", { count: "exact" })
        .order(key).range(rows.length, rows.length + 499);
      if (error) throw new Error(`Read ${table}: ${error.message}`);
      rows.push(...(data ?? []));
      if (count !== null && rows.length >= count) break;
      if (!data?.length) throw new Error(`Incomplete snapshot of ${table}`);
    }
    saved.tables[table] = rows;
  }
  return saved;
}

async function replace(rows: Snapshot["tables"]) {
  for (const [table, key] of [...tables].reverse()) {
    if (table === "runtime_config") continue;
    const { error } = await db.from(table).delete().not(key, "is", null);
    if (error) throw new Error(`Delete ${table}: ${error.message}`);
  }
  for (const [table] of tables) {
    const values = rows[table];
    for (let start = 0; start < values.length; start += 100) {
      const batch = values.slice(start, start + 100);
      const { error } = table === "runtime_config"
        ? await db.from(table).upsert(batch) : await db.from(table).insert(batch);
      if (error) throw new Error(`Insert ${table}: ${error.message}`);
    }
  }
}

async function main() {
  const restoreIndex = process.argv.indexOf("--restore");
  const apply = process.argv.includes("--apply") || restoreIndex >= 0;
  const hospital = process.argv.includes("--hospital");
  const demo = hospital ? buildHospitalDataset(process.env.DEMO_ANCHOR_ISO) : buildDemoDataset(process.env.DEMO_ANCHOR_ISO);
  let replacement: Snapshot["tables"] = Object.fromEntries(tables.map(([table]) => [table, []]));
  Object.assign(replacement, {
    technicians: demo.technicians.map(technicianToRow), jobs: demo.jobs.map(jobToRow),
    agent_decision_log: demo.decisions.map(decisionToRow), approval_requests: demo.approvals.map(approvalToRow),
    notifications: demo.notifications.map(notificationToRow), job_feedback: demo.feedback.map(feedbackToRow),
    runtime_config: [configToRow(demo.config)],
  });
  if (restoreIndex >= 0) {
    const path = process.argv[restoreIndex + 1];
    if (!path) throw new Error("--restore requires a snapshot path");
    const original = JSON.parse(await readFile(path, "utf8")) as Snapshot;
    if (original.project !== project) throw new Error("Snapshot belongs to a different database");
    if (tables.some(([table]) => !Array.isArray(original.tables[table]))) throw new Error("Incomplete snapshot");
    replacement = original.tables;
  }
  console.log(`Target: ${project}`);
  console.log(Object.fromEntries(tables.map(([table]) => [table, replacement[table].length])));
  if (!apply) {
    console.log(`Preview only. Stop the app, then run npm run ${hospital ? "seed:hospital" : "seed:demo"} -- --apply to back up and replace application rows.`);
    return;
  }

  // Reads every table successfully before any deletion. Never touch schema,
  // auth users, storage, publications, policies, or unrelated tables.
  const before = await snapshot();
  if (restoreIndex < 0 && before.tables.runtime_config[0]) {
    // Provider choice is infrastructure configuration, not showcase data.
    replacement.runtime_config[0].llm_mode = before.tables.runtime_config[0].llm_mode;
  }
  const directory = resolve("data-snapshots");
  await mkdir(directory, { recursive: true });
  const backupPath = resolve(directory, `before-demo-${Date.now()}.json`);
  await writeFile(backupPath, JSON.stringify(before, null, 2));
  console.log(`Backup: ${backupPath}`);
  // Verify all outgoing columns are supported before deleting anything.
  for (const [table] of tables) {
    const columns = [...new Set(replacement[table].flatMap(Object.keys))];
    if (!columns.length) continue;
    const { error } = await db.from(table).select(columns.join(",")).limit(0);
    if (error) throw new Error(`Schema preflight ${table}: ${error.message}. Apply migrations first.`);
  }
  try {
    await replace(replacement);
    for (const [table] of tables) {
      const { count, error } = await db.from(table).select("*", { count: "exact", head: true });
      if (error || count !== replacement[table].length) throw new Error(`Verification failed for ${table}`);
    }
  } catch (error) {
    console.error("Replacement failed; restoring original application rows.");
    try { await replace(before.tables); console.error("Original rows restored."); }
    catch (restoreError) { console.error(`Restore failed. Retain ${backupPath} and use --restore.`, restoreError); }
    throw error;
  }
  if (restoreIndex >= 0) {
    console.log("Snapshot restored.");
    return;
  }
  const manifest = hospital ? "hospital-manifest.json" : "demo-manifest.json";
  await writeFile(resolve(directory, manifest), JSON.stringify({
    project, anchorISO: demo.anchorISO, clockMode: "real", backupPath,
    scenarios: demo.scenarios,
    tracking: demo.jobs.filter((job) => job.tech_substatus === "en_route").map((job) => ({
      jobId: job.job_id, path: `/track/${job.public_tracking_token}`,
    })),
  }, null, 2));
  console.log(`Showcase loaded and row counts verified. See data-snapshots/${manifest}.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
