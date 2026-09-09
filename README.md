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
Job-Intake Agent ......... LLM   free-text → structured skill[] / urgency / time window
   ▼
Pricing Engine ........... rule  base_price[skill] × tier_multiplier — priced once, on the real skills
   ▼
Capacity/Yield Agent ..... rule  fleet thresholds + per-skill saturation forecast
   ▼
Technician-State Agent ... rule  pure state store / roster query (least-privilege)
   ▼
Assignment/Scoring Agent . rule  transparent scoring formula; skill match = hard filter
   ▼
Assignment Tie-break ..... LLM   ambiguity-only — picks within the eligible top-3, pick is re-scored
   │
   ├─ technician free, no conflict ─────→ auto-commit → Notification Agent (LLM)
   ├─ no eligible technician (no bump) ─→ Assignment Edge-case Agent (LLM: widen / split / pair / escalate)
   └─ conflict (urgent must bump) ──────→ Disruption Agent (LLM: DESIGNS the re-plan)
                                            ├─ low impact, all safety rails clear ─→ auto-commit
                                            ├─ impact over threshold ──────────────→ HITL Approval Gate
                                            └─ every option touches a frozen job ──→ no re-plan; job unassignable
```

Nine agents: Job-Intake, Pricing, Capacity, Technician-State, Assignment/Scoring,
Assignment Tie-break, Assignment Edge-case, Disruption, Notification.

Design principle: **LLMs only where natural-language reasoning or genuine
judgement is needed** (intake, tie-break, edge-case, disruption, notification).
Pricing, capacity, technician-state and the core scoring formula are pure rules —
cheaper, deterministic, auditable. Wherever an LLM has authority, the rule layer
enumerates a legal space, the LLM chooses within it, and the rule layer
re-validates the choice; every fallback is deterministic.

Every agent writes one row to `agent_decision_log` (agent, reasoning kind, inputs,
outputs, score breakdown, guardrail notes). That table is the Agent Reasoning Feed
on the Admin dashboard and the observability artifact for the submission.

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

npm run seed                    # load demo technicians + jobs
npm run dev                     # http://localhost:3000
```

### Scripts

| command | what it does |
|---|---|
| `npm run seed` | wipe + load the demo starting state |
| `npm run seed -- --keep` | load only if the DB is empty |
| `npx tsx scripts/smoke.ts` | end-to-end pipeline test (clean / bump→HITL / injection) |
| `npm run eval` | golden-path + adversarial eval suite (4 scenarios, invariant-based so it passes on stub and the real gateway alike) |
| `npm run robustness` | runs the demo-critical scenarios at a few SGT hours (guards against time-of-day fragility); `ROBUSTNESS_HOURS=…` to widen the sweep |
| `npm run fuzz` | throws unusual bookings (emoji, huge text, injection, category mismatch) at the pipeline and checks the always-true invariants |
| `npm run concurrency` | fires several bookings at once; checks the schedule stays consistent (the pipeline serializes itself) |

All four run under whatever `LLM_MODE` is set (`LLM_MODE=stub npm run …` forces the
deterministic offline path). Run them one at a time — they share the Supabase project
and wipe/re-seed between cases.

## The three interfaces

| Path | Persona | Purpose |
|---|---|---|
| `/admin` | Coordinator | Dashboard, Agent Reasoning Feed, master schedule, HITL queue, Settings |
| `/book` | Customer | Booking form + status tracker |
| `/tech` | Technician | Mobile-first job schedule, notification acknowledgement |

## Environment variables

See `.env.example`. `LLM_MODE=stub` needs no LLM credentials.
`LLM_MODE=gateway` needs `LLM_GATEWAY_URL` + `LLM_GATEWAY_API_KEY` + `LLM_MODEL`;
`LLM_MODE=openai` needs `OPENAI_API_KEY`.
Check `/api/health` — `llm_provider_ready` tells you whether the selected mode has its credentials.
