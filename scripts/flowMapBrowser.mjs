// Real Chromium/SMIL regression check with mocked API data. No live services.
// Run with Node 22+: node scripts/flowMapBrowser.mjs
// Set CHROME_PATH when Chromium is not installed at the Windows default path.
import assert from "node:assert/strict";
import { build } from "esbuild"; // provided by the project's tsx dependency
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";

const fixture = `
import React, { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentFlowMap } from "./src/components/AgentFlowMap";
import { useRealtime } from "./src/components/useRealtime";
const row = (n, agent_name, patch = {}) => ({
  log_id: 'log_' + (1800000000000 + n).toString(36) + '_' + n.toString(36),
  timestamp: '2026-09-24T00:00:00.000Z', job_id: 'one', agent_name,
  reasoning_kind: 'rule', input_summary: {}, output_summary: {},
  score_breakdown: null, candidates: null, replan_options: null,
  requires_human_approval: false, outcome: 'info', approved_by: null,
  headline: agent_name, latency_ms: 0, guardrail_notes: [], ...patch,
});
const paused = [row(1, 'Orchestrator', {output_summary:{pipeline:'start'}}),
  row(2,'JobIntakeAgent'), row(3,'PricingEngine'), row(4,'CapacityAgent'),
  row(5,'AssignmentAgent'), row(6,'DisruptionAgent', {requires_human_approval:true, outcome:'requires_approval'}),
  row(7,'Orchestrator', {requires_human_approval:true, outcome:'requires_approval'})];
let rows = paused;
window.approve = () => { rows = [...paused, row(8,'Orchestrator', {
  log_id: 'log_' + (1800000000008).toString(36) + '_1', outcome:'approved',
  output_summary:{result:'replan_approved'}}), row(9,'NotificationAgent'), row(10,'NotificationAgent')]; window.emitFlowChange(); };
window.fetch = async (url) => {
  if (!String(url).startsWith('/api/decisions?')) throw new Error('Unexpected request: ' + url);
  const job = new URL(url, location.origin).searchParams.get('job');
  if (job === 'slow') await new Promise(r => setTimeout(r, 1200));
  return Response.json({decisions: job === 'one' ? [...rows].reverse() :
    [row(20, 'Orchestrator', {job_id: job, headline: job, output_summary:{pipeline:'start'}})]});
};
function Fixture() {
  // The discovery page and the map both subscribe to this same table.
  useRealtime('agent_decision_log', () => {});
  const [jobId, setJobId] = useState('one');
  window.selectJob = setJobId;
  return <AgentFlowMap jobId={jobId} job={null} />;
}
createRoot(document.getElementById('root')).render(<StrictMode><Fixture /></StrictMode>);
`;

const bundle = await build({
  stdin: { contents: fixture, loader: "tsx", resolveDir: process.cwd() },
  bundle: true, write: false, platform: "browser", jsx: "automatic",
  plugins: [{
    name: "mock-realtime",
    setup(build) {
      build.onResolve({ filter: /lib\/supabase$/ }, () => ({ path: "mock-realtime", namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
        const channels = new Map();
        window.duplicateChannels = 0;
        window.emitFlowChange = () => channels.forEach(c => c.emit());
        window.failFlowChannels = () => channels.forEach(c => c.fail());
        export function browserClient() {
          return { channel(topic) {
            let active = true, onChange, onStatus;
            const channel = {
              on(event, filter, callback) { onChange = callback; return channel; },
              subscribe(callback) {
                onStatus = callback;
                if (channels.has(topic)) { window.duplicateChannels++; channels.get(topic).unsubscribe(); }
                channels.set(topic, channel);
                queueMicrotask(() => { if (active) callback('SUBSCRIBED'); });
                return channel;
              },
              unsubscribe() { active = false; channels.delete(topic); onStatus?.('CLOSED'); return Promise.resolve('ok'); },
              emit() { if (active) onChange(); },
              fail() { if (active) onStatus('CHANNEL_ERROR'); },
            };
            return channel;
          }};
        }
      ` }));
    },
  }],
  define: {
    "process.env.NODE_ENV": '"development"',
    "process.env.NEXT_PUBLIC_SUPABASE_URL": '""',
    "process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY": '""',
    "process.env.SUPABASE_SERVICE_ROLE_KEY": '""',
  },
});
const css = await readFile("src/app/globals.css", "utf8");
const server = createServer((req, res) => {
  if (req.url === "/bundle.js") {
    res.setHeader("Content-Type", "application/javascript");
    res.end(bundle.outputFiles[0].contents);
  } else if (req.url === "/style.css") {
    res.setHeader("Content-Type", "text/css");
    res.end(css);
  } else res.end('<html><head><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const profile = await mkdtemp(join(tmpdir(), "coolfix-flow-browser-"));
const chrome = spawn(process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new", "--disable-gpu", "--disable-background-networking", "--no-first-run",
  "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
  "--window-size=1440,1000", "about:blank",
], { windowsHide: true, stdio: "ignore" });
let ws;
try {
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; break; }
    catch { await new Promise(r => setTimeout(r, 100)); }
  }
  assert.ok(port, "Chromium must start with remote debugging enabled");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(targets.find(t => t.type === "page").webSocketDebuggerUrl);
  await once(ws, "open");
  let id = 0;
  const pending = new Map();
  const errors = [];
  let loaded;
  const pageLoaded = new Promise(resolve => { loaded = resolve; });
  ws.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Page.loadEventFired") loaded();
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text);
    if (message.id) {
      const callbacks = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) callbacks.reject(new Error(JSON.stringify(message.error)));
      else callbacks.resolve(message.result);
    }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, { resolve, reject });
    ws.send(JSON.stringify({ id: requestId, method, params }));
  });
  await call("Runtime.enable");
  await call("Page.enable");
  await call("Page.navigate", { url: `http://127.0.0.1:${server.address().port}` });
  await pageLoaded;
  const result = await call("Runtime.evaluate", { awaitPromise: true, returnByValue: true, expression: `
    (async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      const wait = async (test, message) => {
        for (let i = 0; i < 400; i++) { if (test()) return; await sleep(50); }
        throw new Error(message);
      };
      const state = id => document.querySelector('[data-station="' + id + '"]')?.dataset.state;
      await wait(() => state('hitl') === 'halt', 'Initial pipeline must pause at HITL');
      check(window.duplicateChannels === 0, 'Concurrent subscribers must not evict each other');
      check(state('notify') === 'pending', 'Notification must wait for approval');
      window.approve();
      await wait(() => state('hitl') === 'done', 'Approval must release the gate');
      check(state('notify') === 'pending', 'Gate must resolve before notification appears');
      await wait(() => document.querySelector('animateMotion'), 'Approval must animate its return rail');
      const motion = document.querySelector('animateMotion');
      check(motion.getStartTime() > 2, 'Later motion must start now, not at SVG time zero');
      const car = motion.parentNode;
      const before = car.getCTM();
      await sleep(140);
      const after = car.getCTM();
      check(Math.hypot(after.e - before.e, after.f - before.f) > 2, 'The train must visibly move along the rail');
      await wait(() => state('notify') === 'done' && !document.querySelector('animateMotion'), 'Notification must finish');
      window.failFlowChannels();
      await sleep(2700);
      check(state('hitl') === 'done' && state('notify') === 'done', 'Polling must not regress resolved states');
      window.selectJob('slow');
      await sleep(150);
      check(!document.querySelector('[data-station]'), 'Old stations must clear while another job loads');
      window.selectJob('two');
      await wait(() => state('orch') === 'active', 'New job must start animating');
      await sleep(1500);
      check(state('notify') === 'pending' && document.body.textContent.includes('two'), 'Late old-job response must not replace the selected job');
      check(window.duplicateChannels === 0, 'Job switches must preserve independent subscriptions');
      return 'Browser checks passed: Strict Mode, concurrent subscriptions, HITL sequence, SMIL motion, polling stability, and delayed job switches.';
    })()
  ` });
  assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
  assert.deepEqual(errors, []);
  console.log(result.result.value);
} finally {
  ws?.close();
  const exited = once(chrome, "exit");
  chrome.kill();
  await exited;
  server.close();
  // Only remove the exact isolated profile created by this test.
  if (resolve(profile).startsWith(resolve(tmpdir()) + sep) && profile.includes("coolfix-flow-browser-")) {
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
