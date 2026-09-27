# Showcase dataset and verification

`npm run seed:demo` previews the dataset. With the app stopped, run
`npm run seed:demo -- --apply` to back up and replace application data in the
Supabase project configured in `.env.local`. The original small `npm run seed`
fixture and the app's Reset button remain available for regression demos.
Reset returns to that smaller fixture; rerun `seed:demo -- --apply` to restore
the large showcase.

The loader reads every application table before deleting any rows, saves raw
rows under ignored `data-snapshots/before-demo-*.json`, checks outgoing columns,
loads in foreign-key order, and verifies counts. On failure it attempts to
restore the snapshot. This uses REST requests, not a single SQL transaction;
stop other app instances/writers during replacement. Tables, indexes, policies,
publications, Auth, and Storage are not deleted. The LLM provider setting is
preserved; scheduling settings are set to the showcase defaults.

Restore a saved snapshot with:

```sh
npm run seed:demo -- --restore data-snapshots/before-demo-<timestamp>.json
```

The loaded showcase contains:

| Records | Count |
| --- | ---: |
| Technicians | 12 |
| Jobs | 174 |
| Customer feedback | 68 |
| Decision replay rows | 1,364 |
| Simulated notifications | 340 |
| Pending human approvals | 4 |

The app always uses the current system time. Seed data defaults to today's
Singapore date, with a 09:00 dataset anchor. `DEMO_ANCHOR_ISO` selects another
dataset date without changing the runtime clock. There are 34 appointments on each of five days: two historical days,
today, and the next two days. The four extra jobs await human decisions.
Technicians and successive stops are 8–20 km apart in straight-line distance;
road distances are longer. Schedules allow travel time and full service
durations, including three-hour chiller visits and 14:30 appointments.

Open `/admin/schedule` for the day/week schedule, `/admin/approvals` for the
four scenarios, and `/tech?tech=tech_wei_jie` for an en-route technician with
multiple cross-district stops. Customer tracking links and the snapshot path
are saved to `data-snapshots/demo-manifest.json` after each replacement.

| Approval | Human decision |
| --- | --- |
| `demo_approval_1` | An urgent pharmacy visit displaces a standard customer's appointment. Choose a new visit on day +3 after confirming consent. |
| `demo_approval_2` | A clinic outage would displace a frozen appointment. A named coordinator must authorize the emergency override. |
| `demo_approval_3` | A plant needs a supervised pair and an isolation permit. Accepting assigns manual follow-up; it does not automatically dispatch an unsafe team. |
| `demo_approval_4` | A customer disputes the quote and refuses site access. Accepting records manual follow-up; it does not charge or dispatch. |

All people, feedback, decision replays, and notification records are synthetic.
Seeded notification rows do not deliver external messages.

## Routing and congestion

OSRM supplies actual road geometry. The traffic-camera feed alone does not
measure congestion, so cameras without severity data display as unknown.
Set `DEMO_TRAFFIC=true` in `.env.local` and restart the app to demonstrate
colored congestion segments and adjusted travel estimates along the routed
roads. The UI explicitly labels this **simulated traffic**, not live traffic.
The default in `.env.example` is false. If routing providers are unavailable,
the page reports the failure rather than presenting a straight line as a road
route.

## Database fixes and migration

Full-table repository reads now paginate, including when a server returns fewer
rows than requested. Job replay queries filter by job before limiting results.
Legacy configuration fallback clears simulated-clock overrides and preserves
the policy version while handling missing clock and adaptive-policy columns.
Approval collision checks now run on a projected schedule before any job or
workload writes, so a blocked plan cannot partially change appointments.

The supplied hosted schema was checked and includes columns through migration
0008. Apply `supabase/migrations/0009_technician_realtime.sql` in the Supabase SQL
Editor to add technician updates to the realtime publication. It is additive
and safe to rerun. This migration has **not** been applied by the data loader:
the supplied REST keys do not provide a SQL connection.

## Checks

```sh
npm run build
npm run repo:unit
npm run approval:unit
npm run demo:unit
npm run routing:unit
npm run tracking:unit
npm run feedback:unit
npm run adaptive:unit
npm run assignment:unit
```

The demo suite checks skills, working hours, travel gaps, SLA deadlines, tokens,
references, workloads, and actual replan application for every proposed option.
The repository suite reproduces truncation with 1,207 rows and a lowered server
page cap. Routing tests mock provider failures and camera-only responses, and
verify explicit simulated congestion and first-leg ETA calculations.

Existing DB-backed smoke/eval scripts wipe and reseed the shared database; run
them before loading the final showcase, not while presenting it.

Verification completed for this change: production build and all eight suites
above passed. Live health reported 174 jobs and 12 technicians; the oldest
job's replay returned all eight rows, and four approvals remained pending.
Headless Edge checks covered desktop and 320/390px mobile screens, a browser
in the America/Los_Angeles timezone, real OpenStreetMap tile loading, road
routing with labeled simulated congestion, and customer tracking. No browser
exceptions were observed. Screenshots are under `data-snapshots/browser/`.
