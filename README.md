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
Pricing Engine ........... rule-based, no LLM  (deterministic pricing)
   ▼
Job-Intake Agent ......... LLM  (free-text → structured skill/urgency/window)
   ▼
Capacity/Yield Agent ..... rule-based, no LLM  (hard thresholds from config)
   ▼
Technician-State Agent ... no LLM  (pure state store / roster query)
   ▼
Assignment/Scoring Agent . rule-based  (transparent scoring formula)
   ├─ no conflict ─────────────────→ auto-commit → Notification Agent
   └─ conflict (must bump a job) ──→ Disruption Agent (LLM: narrate + rank re-plans)
                                       ├─ low impact ─────→ auto-commit
                                       └─ customer impact / frozen job
                                            └─→ HITL Approval Gate (coordinator)
```

Design principle: **LLMs only where natural-language reasoning is genuinely
needed** (intake, disruption narration, notification copy). Pricing, capacity and
technician-state are pure rules — cheaper, deterministic, auditable.

Every agent writes one row to `agent_decision_log` (agent, reasoning kind, inputs,
outputs, score breakdown, guardrail notes). That table is the Agent Reasoning Feed
on the Admin dashboard and the observability artifact for the submission.

## Stack

- **Next.js 14** (App Router) + TypeScript — one app, all three UIs + agent API
- **Supabase** (Postgres + Realtime) — data store; the Reasoning Feed subscribes
  to `agent_decision_log` inserts
- **AWS Bedrock — Claude Sonnet 4.5** for LLM calls (`LLM_MODE=bedrock`), with a
  deterministic **stub mode** (`LLM_MODE=stub`, the default) so the demo runs
  offline and never burns AWS credit

## Local setup

```bash
npm install
cp .env.example .env.local      # fill in Supabase URL + keys

# one-time: run the schema
#   open Supabase → SQL Editor → paste supabase/migrations/0001_init.sql → Run

npm run seed                    # load demo technicians + jobs
npm run dev                     # http://localhost:3000
```

### Scripts

| command | what it does |
|---|---|
| `npm run seed` | wipe + load the demo starting state |
| `npm run seed -- --keep` | load only if the DB is empty |
| `npx tsx scripts/smoke.ts` | end-to-end pipeline test (clean / bump→HITL / injection) |
| `npm run eval` | golden-path + adversarial eval suite |

## The three interfaces

| Path | Persona | Purpose |
|---|---|---|
| `/admin` | Coordinator | Dashboard, Agent Reasoning Feed, master schedule, HITL queue, Settings |
| `/book` | Customer | Booking form + status tracker |
| `/tech` | Technician | Mobile-first job schedule, notification acknowledgement |

## Environment variables

See `.env.example`. `LLM_MODE=stub` needs no AWS credentials.
