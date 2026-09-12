# CoolFix — Features & Endpoints

Everything currently in the codebase: the four user-facing surfaces, every admin
screen, the agent pipeline that powers them, and the full REST API each one calls.

---

## 1. Public surfaces

### 1.1 Landing / persona picker — `/`
Entry point linking to the interfaces below. Also links out to `/api/health`.
No API calls of its own beyond that link.

### 1.2 Customer booking form — `/book`
Multi-step booking flow: welcome → address (map picker) → problem details → tier
selection → confirm → live processing → live status tracking.

| Endpoint | Method | Used for |
|---|---|---|
| `/api/bookings` | `POST` | Submit the booking; runs the full agent pipeline synchronously and returns the result (assigned tech, price, or HITL-pending status). |
| `/api/jobs/:id` | `GET` | Poll the created job for live status while tracking. |
| `/api/decisions?job=:id` | `GET` | Realtime feed subscription fallback — show pipeline progress while "processing". |

### 1.3 Technician app — `/tech`
Mobile-style personal schedule: pick a technician (or deep-link via `?tech=<id>`),
see assigned jobs, acknowledge notifications, update job status from the field.
Deep-links: `?tech=<id>` preselects technician, `?job=<id>` expands a job.

| Endpoint | Method | Used for |
|---|---|---|
| `/api/technicians` | `GET` | Load the technician roster / picker. |
| `/api/bookings` | `GET` | Load jobs, filtered client-side to the selected technician. |
| `/api/notifications?recipient=:techId` | `GET` | Load this technician's inbox. |
| `/api/notifications/:id/ack` | `POST` | "Seen" — acknowledge a notification. |
| `/api/jobs/:id` | `PATCH` | Status transitions: `en_route`, `arrived`, `completed`. Also records `tech_substatus` (`en_route`/`arrived`), which the customer tracker (§1.4) uses to tell those two states apart — the `jobs.status` enum itself only has one "in_progress" value for both. |

### 1.4 Customer tracking — `/track` and `/track/:token`
A no-login, token-gated view of one booking's live status, for a customer who
isn't in the same browser session as the one that made the booking (a different
device, a returning visit, the confirmation email). `/track` is the entry form
("Track My Service") — the customer types the tracking code they were given at
booking time and is sent to `/track/:token`. Every booking response and the
`/book` confirmation screen also link straight to `/track/:token`.

The tracking token (`CF-XXXX-XXXX-XXXX`, e.g. `CF-7KQ9-X2PM-4LR3`) is generated
server-side per booking (`src/lib/trackingToken.ts`), stored on the job
(`jobs.public_tracking_token`, unique-indexed), and is the *only* way in — there
is no customer login/session, and a database id can never be substituted for it
(see `/api/public/jobs/:token` below).

| Endpoint | Method | Used for |
|---|---|---|
| `/api/public/jobs/:token` | `GET` | The token page's data source — status, ETA, technician (once assigned), map coordinates, appointment window, service summary, timeline, a plain-language "why this technician" explanation, and disruption messaging if the appointment was replanned. Returns a generic 404 for any malformed/unknown token — never distinguishes the two, and never accepts a job id in place of the token. |

---

## 2. Admin console — `/admin/*`

Shared shell (`/admin` layout): sidebar nav, pending-approvals badge, freeze-window
countdown, "Reset demo data" button, link to `/api/health`.

| Endpoint | Method | Used for |
|---|---|---|
| `/api/approvals` | `GET` | Sidebar badge — count of pending HITL approvals (polled every 4s). |
| `/api/config` | `GET` | Freeze-window countdown display. |
| `/api/reset` | `POST` | "Reset demo data" — wipes and re-seeds the whole DB. |

### 2.1 Dashboard — `/admin`
Overview: live Agent Reasoning Feed, pipeline stage counts, SG clock/date.

| Endpoint | Method | Used for |
|---|---|---|
| `/api/decisions?limit=200` | `GET` | Agent Reasoning Feed (initial load + polling fallback; realtime via Supabase subscription). |
| `/api/bookings` | `GET` | Job counts per pipeline stage. |
| `/api/technicians` | `GET` | Fleet stats. |

### 2.2 Agent Flow Map — `/admin/flow`
Live animated "metro map" of one job's pipeline — a station per agent, a train
animating each hand-off in real time as it actually happens. Auto-follows the
latest-created booking, or pin to one via `?job=<id>`.

| Endpoint | Method | Used for |
|---|---|---|
| `/api/bookings` | `GET` | Find the latest job (for auto-follow) / power the job picker. |
| `/api/decisions?job=:id` | `GET` | The step-by-step decision log driving the animation, for the followed job. |

### 2.3 Schedule — `/admin/schedule`
Day-view calendar across technicians (07:00–20:00), with each job's tier, slot, and
map location.

| Endpoint | Method | Used for |
|---|---|---|
| `/api/technicians` | `GET` | Calendar rows. |
| `/api/bookings` | `GET` | Jobs placed on the calendar. |
| `/api/approvals` | `GET` | Overlay pending re-plans affecting the schedule. |
| `/api/config` | `GET` | Freeze-window / thresholds context. |

### 2.4 Job Queue — `/admin/queue`
Kanban-style list of all jobs by pipeline stage (`intake → pricing → capacity_check →
scoring → assigned → disruption_review → awaiting_approval → done`), filterable by
tier.

| Endpoint | Method | Used for |
|---|---|---|
| `/api/bookings` | `GET` | Full job list. |
| `/api/technicians` | `GET` | Resolve assigned-technician names. |

### 2.5 Job detail / pipeline replay — `/admin/jobs/:id`
Everything one booking's agents did, step by step, plus the notifications it
produced and whether they were acknowledged. The map shows the job/technician
location.

| Endpoint | Method | Used for |
|---|---|---|
| `/api/jobs/:id` | `GET` | Job + assigned technician detail. |
| `/api/decisions?job=:id` | `GET` | Full ordered decision log for the replay. |
| `/api/notifications?job=:id` | `GET` | Notifications generated for this job + ack state. |

### 2.6 Technicians — `/admin/technicians`
Roster management: view fleet (skills, certs, workload, working hours), add a new
technician.

| Endpoint | Method | Used for |
|---|---|---|
| `/api/technicians` | `GET` | List roster. |
| `/api/technicians` | `POST` | Add a technician. |
| `/api/bookings` | `GET` | Compute current workload per technician. |

### 2.7 Approvals (HITL) — `/admin/approvals`
Human-in-the-loop queue: disruption re-plans / assignment edge-cases that need a
coordinator's sign-off. Shows candidate options (map + reasoning) and lets the
coordinator approve or reject.

| Endpoint | Method | Used for |
|---|---|---|
| `/api/approvals` | `GET` | Pending (and resolved) approval requests. |
| `/api/approvals/:id/resolve` | `POST` | Approve or reject, optionally picking a specific option (`chosenOptionId`). |
| `/api/jobs/:id` | `GET` | Context for the job under review. |
| `/api/technicians` | `GET` | Resolve technician names/details in options. |
| `/api/decisions?job=:id` | `GET` | Show the reasoning that produced this approval request. |

### 2.8 Settings — `/admin/settings`
Tune the rules the agents run on: per-tier scoring weights, capacity thresholds,
freeze window, base prices, HITL sensitivity, LLM mode.

| Endpoint | Method | Used for |
|---|---|---|
| `/api/config` | `GET` | Load current runtime config. |
| `/api/config` | `PATCH` | Save changes (server clamps/normalizes every field). |

### System status
| Endpoint | Method | Used for |
|---|---|---|
| `/api/health` | `GET` | Deployment check — LLM mode/provider readiness, Supabase env presence, DB row counts. Linked from `/` and the admin sidebar. |

---

## 3. Full API reference

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/bookings` | `POST` | Create a booking — runs the full agent pipeline (intake → pricing → capacity → assignment → disruption/HITL → notification). `400` on schema errors, `500` otherwise, `201` on success. |
| `/api/bookings` | `GET` | List all jobs. |
| `/api/jobs/:id` | `GET` | Get one job + its assigned technician. |
| `/api/jobs/:id` | `PATCH` | Technician status transition (`action`: `en_route` \| `arrived` \| `completed`). |
| `/api/decisions` | `GET` | Agent decision log. `?limit=N` (max 500) for the global feed; `?job=<id>` for one job's ordered pipeline replay. |
| `/api/approvals` | `GET` | List HITL approval requests. |
| `/api/approvals/:id/resolve` | `POST` | Resolve one approval. Body: `{ decision: "approve"\|"reject", chosenOptionId?, coordinatorName? }`. `409` if already resolved/invalid state. |
| `/api/notifications` | `GET` | List notifications. Filters: `?recipient=<id>`, `?job=<id>`. |
| `/api/notifications/:id/ack` | `POST` | Acknowledge ("Seen") a notification. |
| `/api/technicians` | `GET` | List the technician roster. |
| `/api/technicians` | `POST` | Add a technician (`name`, `skill_tags[]` required). |
| `/api/config` | `GET` | Get runtime config (dispatch weights, thresholds, prices, LLM mode, freeze window). |
| `/api/config` | `PATCH` | Update runtime config (server-side clamped/whitelisted, never trusts client values directly). |
| `/api/reset` | `POST` | Wipe and re-seed the entire dataset (demo reset). |
| `/api/health` | `GET` | Liveness + LLM mode/provider readiness + Supabase env + DB row counts. |
| `/api/public/jobs/:token` | `GET` | Customer tracking — the only endpoint gated by the tracking token instead of app-internal trust. Sanitized, allow-listed response (see §1.4); generic `404` for any invalid/unknown token. |

---

## 4. The agent pipeline (what `/api/bookings POST` actually runs)

```
Customer booking
   │
   ▼
Job-Intake ............... LLM    free text → structured skill[] / urgency / time window
   ▼
Pricing .................. rule   base_price[skill] × tier multiplier
   ▼
Capacity/Yield ........... rule   fleet + per-skill saturation thresholds
   ▼
Assignment/Scoring ....... rule   transparent formula; skill match is a hard filter
   ├─ ambiguous result ──────────→ Assignment Tie-break (LLM, picks within top-3, re-scored)
   ├─ no eligible tech ──────────→ Assignment Edge-case (LLM: widen_window / split_visit / pair_junior_senior / escalate)
   └─ conflicts an existing slot → Disruption (LLM, ranks a pre-validated re-plan shortlist)
   ▼
auto-commit ─or─ HITL approval gate (Approvals screen)
   ▼
Notification ............. LLM    composes technician/customer messages from structured facts only
```

Every agent call is logged via `agents/log.ts` and streamed to `/api/decisions`,
which is what powers the Agent Reasoning Feed (`/admin`) and the Agent Flow Map
(`/admin/flow`) in real time.
