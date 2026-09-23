# CoolFix — Multi-Agent Technician Scheduling

A multi-agent system that dispatches aircon-servicing technicians in Singapore and
handles schedule disruptions — with **explainable decisions** (every agent step is
logged and shown live) and **risk-calibrated human-in-the-loop** approval gates.

Built for the *Show Me Your Agents Hackathon* (NUS ISS, Public track).

---

## Architecture

```
Customer booking
   │
   ▼
Job-Intake Agent ......... LLM   free-text → structured skill[] (urgency comes from the customer's tier, not inferred)
   ▼
Pricing Engine ........... rule  base_price[skill] × tier_multiplier — priced once, on the real skills
   ▼
Capacity Agent ........... rule  fleet thresholds + per-skill saturation forecast
   ▼
Assignment/Scoring Agent . rule  transparent scoring formula; hard constraints (skill, hours, clash, route) filter first
   ▼
Assignment Tie-break ..... LLM   ambiguity-only — picks within the eligible top-3, pick is re-scored
   │
   ├─ technician free, no conflict ─────→ auto-commit → Notification Agent (LLM)
   ├─ no eligible technician (no bump) ─→ Assignment Edge-case Agent (LLM: widen / split / pair / escalate)
   └─ conflict (urgent must bump) ──────→ Disruption Agent (LLM: DESIGNS the re-plan)
                                            ├─ low impact, all safety rails clear ─→ auto-commit
                                            ├─ impact over threshold ──────────────→ HITL Approval Gate (standard)
                                            └─ every option touches a frozen job ──→ no re-plan; job unassignable

A second, independent front door into the same Disruption Agent machinery:

Coordinator marks a technician unavailable (/admin/technicians)
   │
   ▼
For each of their remaining, not-yet-started jobs today:
   ├─ a same-slot swap exists (rule only — reuses the Assignment Agent's own
   │   scoring formula, no LLM call, appointment time never changes) ──┐
   │                                                                    │
   └─ nobody else is free at that slot → Disruption Agent (LLM re-plan  │
       search, same generate/propose/re-validate/re-rank discipline    │
       as above, now finding a new SLOT instead of a new TECHNICIAN)   │
                                                                        ▼
                                              was the job already inside its
                                              freeze window?
                                                ├─ no  → same auto-commit-vs-HITL
                                                │        risk gate as above
                                                └─ yes → ALWAYS a human — Emergency
                                                         Override HITL gate, however
                                                         low-impact the fix otherwise is
```

Eight agents: Job-Intake, Pricing, Capacity, Assignment/Scoring, Assignment
Tie-break, Assignment Edge-case, Disruption, Notification. (The Orchestrator
wires them together but isn't itself LLM- or rule-scored — it's the reasoning
loop.)

Design principle: **LLMs only where natural-language reasoning or genuine
judgement is needed** (intake, tie-break, edge-case, disruption, notification).
Pricing, capacity, and the core scoring formula are pure rules — cheaper,
deterministic, auditable. Wherever an LLM has authority, the rule layer
enumerates a legal space, the LLM chooses within it, and the rule layer
re-validates the choice; every fallback is deterministic. No LLM output ever
reaches a database write without passing back through that rule layer first.

Every agent writes one row to `agent_decision_log` (agent, reasoning kind, inputs,
outputs, score breakdown, candidate rejection reasons, re-plan options, guardrail
notes). That table is the Agent Reasoning Feed on the Admin dashboard, the live
Agent Flow Map, and the observability artifact for the submission — structured
data only, never a raw LLM completion or chain-of-thought.

### Technician-unavailable disruption (the demo centerpiece)

`/admin/technicians` → expand a technician → "Mark unavailable for today." This
is a second entry point into the disruption-handling code in
`src/agents/disruption.ts`/`src/agents/orchestrator.ts` (`runTechnicianUnavailable`),
not a separate system: it reuses the same hard-constraint scoring, the same
LLM-proposes/rule-validates re-plan search, and the same risk-calibrated
auto-commit gate as the booking-conflict path above. The seed data ships two
deterministic demo pairs for this (`src/data/seed.ts`):

- **Daniel Ong unavailable** → job_2012 (not frozen) has a same-slot
  replacement → **auto-commits** with no LLM call needed at all.
- **Marcus Tan unavailable** → job_2001 is inside its freeze window → **always**
  routes to a coordinator as an Emergency Override, regardless of how clean
  the fix would otherwise be — the one code path allowed to touch a frozen
  job, and only with a human's name on the approval.

Run `npm run disruption:smoke` for the end-to-end, DB-backed proof (both
scenarios, plus that approving the Emergency Override actually commits the
right technician rather than silently reverting).

### Customer tracking & feedback

Every booking gets a server-generated, unguessable tracking token
(`CF-XXXX-XXXX-XXXX`, 60 bits of entropy, never derived from `job_id`) —
`/track/:token` and `GET /api/public/jobs/:token` are the only way to read a
job without the internal API surface. The response is an explicit allow-list
projection (`src/lib/publicTracking.ts`) — technician name/specialty/live
location while en route, status, ETA, price — never scores, candidate lists,
other jobs, or technician contact details. Both the tracking lookup and
feedback submission are rate-limited server-side.

After a job completes, the customer can leave a 1–5★ rating, structured tags,
and an optional comment (`src/lib/feedback.ts`) — validated, deduplicated
(including a real concurrent-race test), and Bayesian-smoothed
(`src/lib/rating.ts`) so one review can't swing a technician's score and a
new hire is never penalised for a cold start. The rating is shown to
coordinators and feeds the adaptive-policy loop below, but its scoring weight
is hard-zeroed in three independent places (`DISPATCH_POLICY` defaults, the
adaptive policy's own cap, and unconditionally inside `scoring.ts` itself) —
customer feedback can never move which technician gets picked. Free-text
comments are never sent to an LLM anywhere in the codebase.

### Adaptive dispatch policy

Customer feedback closes a second, conservative loop: completed-job feedback is
joined to its delivery tier, technician, assignment score, reschedule history, and
the policy snapshot used at assignment time. `src/lib/adaptivePolicy.ts` aggregates
validated ratings and fixed tags, applies Bayesian smoothing, requires both a
minimum sample and multiple technicians, caps one technician's contribution, flags
suspicious bursts/repeated patterns, and proposes at most a small normalized change
to soft scoring weights. Free-text comments are never an adaptive signal and are
never sent to an LLM.

The default flow is recommendation-only: a coordinator opens `/admin/company`,
reviews the explanation and included/excluded feedback IDs, approves, and applies.
Settings can explicitly enable automatic mode, but the same checks, cooldown, audit
history, and optimistic policy-version check still apply. Rollback restores the
exact previous tier snapshot and creates a rollback history row.

The current app has no authentication, company table, or production tenant
isolation. Adaptive data is therefore scoped to the explicit `demo-company` value;
complete Sybil protection and real `company_id` authorization require those later
identity systems. Arrival/start/completion event timestamps are also not currently
recorded, so late-arrival frequency is reported as unavailable rather than guessed.

## Stack

- **Next.js 14** (App Router) + TypeScript — one app, all three UIs + agent API
- **Supabase** (Postgres + Realtime) — data store; the Reasoning Feed subscribes
  to `agent_decision_log` inserts
- **Leaflet + OpenStreetMap** — the customer's address picker and the live
  booking-tracker map. Client-side only (tiles from `openstreetmap.org`,
  geocoding via Nominatim); no API key, and it falls back to a fixed area
  list if unreachable. The backend still only handles a validated `{lat,lng}`.
- **LLM calls** via one client (`src/lib/llm.ts`) with three interchangeable modes —
  same prompt frame + JSON contract, so no agent code changes:
  - `LLM_MODE=stub` (default) — deterministic fixtures, no network, no credit burned
  - `LLM_MODE=gateway` — **the hackathon provider**: Claude Sonnet 4.5 via the
    organisers' self-hosted AWS LLM gateway (Ollama-compatible `/api/chat`,
    `X-API-Key` auth). Needs `LLM_GATEWAY_URL`, `LLM_GATEWAY_API_KEY`, `LLM_MODEL`
  - `LLM_MODE=openai` — OpenAI Chat Completions (`OPENAI_MODEL`, default
    `gpt-4o-mini`); dev fallback

## Local setup

```bash
npm install
cp .env.example .env.local      # fill in Supabase URL + keys

# one-time: run the migrations in order, in the Supabase SQL Editor:
#   supabase/migrations/0001_init.sql
#   supabase/migrations/0002_edgecase_agent.sql
#   supabase/migrations/0003_tiebreak_agent.sql
#   supabase/migrations/0004_dispatch_policy.sql
#   supabase/migrations/0005_public_tracking.sql   (customer tracking token)
#   supabase/migrations/0006_job_feedback.sql      (customer feedback + rating)
#   supabase/migrations/0007_runtime_clock.sql     (runtime clock fields)
#   supabase/migrations/0008_adaptive_dispatch_policy.sql

npm run seed                    # load demo technicians + jobs
npm run dev                     # http://localhost:3000
```

### Scripts

| command | what it does |
|---|---|
| `npm run seed` | wipe + load the demo starting state |
| `npm run seed -- --keep` | load only if the DB is empty |
| `npm run smoke` | end-to-end pipeline test (clean / bump→HITL / injection) |
| `npm run eval` | golden-path + adversarial eval suite (invariant-based so it passes on stub and the real gateway alike) |
| `npm run robustness` | runs the demo-critical scenarios at a few SGT hours (guards against time-of-day fragility); `ROBUSTNESS_HOURS=…` to widen the sweep |
| `npm run fuzz` | throws unusual bookings (emoji, huge text, injection, category mismatch) at the pipeline and checks the always-true invariants |
| `npm run concurrency` | fires several bookings at once; checks the schedule stays consistent (the pipeline serializes itself) |
| `npm run assignment:unit` | pure-logic tests for the tie-break ambiguity detector (close scores / weak lone match) |
| `npm run disruption:smoke` | DB-backed technician-unavailable demo: auto-commit case, Emergency Override HITL case, and that approving it actually commits |
| `npm run tracking:unit` | pure-logic tests for tracking-token generation/format and the public-view allow-list |
| `npm run tracking:smoke` | DB-backed tracking scenarios: token auth, malformed/unknown-token handling, status/ETA updates |
| `npm run feedback:unit` | pure-logic validation + Bayesian smoothing/trend tests |
| `npm run feedback:smoke` | DB-backed feedback flow: submission, duplicate rejection (incl. a real concurrent race), and that ratings never affect scoring |
| `npm run adaptive:unit` | deterministic adaptive-policy, smoothing, anomaly, normalization, and safety tests |
| `npm run adaptive:smoke` | DB-backed recommendation → approval → apply → future assignment snapshot → rollback flow |

All of these run under whatever `LLM_MODE` is set (`LLM_MODE=stub npm run …` forces
the deterministic offline path). Run them one at a time — they share the Supabase
project and wipe/re-seed between cases.

## The interfaces

| Path | Persona | Purpose |
|---|---|---|
| `/admin` | Coordinator | Dashboard, Agent Reasoning Feed, live Agent Flow Map, master schedule, HITL Approvals queue, technician roster + performance + disruption trigger, Company (adaptive policy), Settings |
| `/book` | Customer | Booking form (natural-language problem description) + live pipeline progress |
| `/track/:token` | Customer | Status/ETA tracking by tracking-token link (no login), post-completion feedback |
| `/tech` | Technician | Mobile-first job schedule, notification acknowledgement |

## Environment variables

See `.env.example`. `LLM_MODE=stub` needs no LLM credentials.
`LLM_MODE=gateway` needs `LLM_GATEWAY_URL` + `LLM_GATEWAY_API_KEY` + `LLM_MODEL`;
`LLM_MODE=openai` needs `OPENAI_API_KEY`.
Check `/api/health` — `llm_provider_ready` tells you whether the selected mode has its credentials.
