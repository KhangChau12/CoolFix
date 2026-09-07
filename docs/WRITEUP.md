# CoolFix — Technical Write-up

**Show Me Your Agents Hackathon · NUS ISS · Public track**

CoolFix is a multi-agent system that automates technician dispatch for an
aircon-servicing SME in Singapore, and handles the schedule disruptions that
break a manual dispatcher's day. It is built around two ideas most entries
skip: **every decision is explained**, and **the machine hands control back to
a human exactly when the risk warrants it — no sooner, no later**.

---

## 1. Problem & business value

A service coordinator at an aircon company assigns technicians to customer
jobs based on location, certification, and urgency. Done by hand this is slow,
produces inefficient routes, and collapses when an emergency job appears and
the whole day has to be re-planned.

CoolFix targets the coordinator (the primary user) in a B2B2C shape: the
customer books at one end, the technician receives work at the other, the
coordinator owns the system in the middle.

Value: faster assignment, fewer wasted kilometres, and — critically — a
**defensible audit trail** for every schedule change, including the ones a
human approved.

## 2. Architecture & the reasoning loop

```
Customer booking
   │
   ▼
Job-Intake Agent ......... LLM       free-text → {skill_required, urgency, window}
   ▼
Pricing Engine ........... rule      deterministic price from skill × tier (priced once, on the real skills)
   ▼
Capacity/Yield Agent ..... rule      daily thresholds + per-skill saturation forecast
   ▼
Technician-State Agent ... rule      roster + location + load (state store)
   ▼
Assignment/Scoring Agent . rule      transparent formula, skill = hard filter
   ▼
Assignment Tie-break ..... LLM       ambiguity-only: close scores / one strained
   │                                 candidate / urgent with no strong fit. Picks
   │                                 within the eligible top-3; the pick is
   │                                 re-scored against live state before commit.
   │                                 Unambiguous ranking → this agent never runs.
   ├─ no conflict ───────────────→ auto-commit → Notification Agent (LLM)
   ├─ no eligible technician ────→ Assignment Edge-case Agent (LLM: widen / split / pair / escalate)
   └─ conflict (must bump) ──────→ Disruption Agent (LLM: designs the re-plan)
                                     ├─ low impact ─────────→ auto-commit
                                     └─ customer impact OR
                                        frozen job touched ─→ HITL Approval Gate
```

**State management.** One booking = one `AgentContext`. It loads the
technician roster, the job list and config **once**, so the scoring pass
doesn't fan out into dozens of database round-trips; it buffers every
decision-log row and every job write, and flushes them in a deterministic
order at the end. The reasoning loop's state is explicit and inspectable, not
smeared across ad-hoc queries.

**Why some agents are not LLMs — a deliberate decision.** Pricing, capacity,
technician-state and the core scoring formula are pure rules / bookkeeping.
Putting an LLM there would add latency, cost, and non-determinism for zero
benefit, and would make the system *less* trustworthy. LLMs are used only
where genuine judgement is needed — and even then, the rule layer bounds
what the LLM can choose from and re-checks what it picked:

| Agent | LLM? | Why / how it's bounded |
|---|---|---|
| Job-Intake | **yes** | interpreting a customer's free-text symptom description |
| Pricing | no | `base_price[skill] × tier_multiplier` — must be exact and free |
| Capacity | no | threshold + per-skill saturation, both deterministic |
| Technician-State | no | a database query |
| Assignment/Scoring | no | the formula is transparent and auditable by design |
| Assignment Tie-break | **yes**, ambiguity-only | runs only when the formula is a coin-flip; picks within the eligible top-3, and the pick is re-scored against live state before commit — it can re-order the eligible set, never reach past it |
| Assignment Edge-case | **yes**, no-candidate-only | picks one pre-validated lever (widen window / split visit / supervised pair / escalate) |
| Disruption | **yes** | designs the re-plan inside a pre-verified legal slot space; every move is cross-checked and the plan re-simulated against live state |
| Notification | **yes** | writing a natural message for a customer / technician |

The pattern is the same everywhere an LLM has authority: **the rule layer
enumerates a legal space, the LLM chooses within it, the rule layer
re-validates the choice.** The LLM never produces a value that could bypass a
hard constraint, and every fallback is deterministic.

The LLM client (`src/lib/llm.ts`) has one entry point (`callLlm`) and three
interchangeable modes behind the same prompt frame and JSON contract, so
switching providers touches no agent code:

- `LLM_MODE=stub` (default) — deterministic fixtures; the demo runs offline
  and never spends credit.
- `LLM_MODE=bedrock` — Claude Sonnet 4.5 on AWS Bedrock (`InvokeModel`).
- `LLM_MODE=openai` — OpenAI Chat Completions over plain `fetch` (no extra
  SDK), `response_format: json_object` to hold the contract.

A per-process call budget hard-stops runaway loops, and results are cached by
input hash so re-running a demo step is free. `/api/health` reports the
active mode and whether its credentials are present.

## 3. Tool use & typed schemas

Every message that crosses an agent boundary is a typed shape in
`agents/schemas.ts` with a `validate*` guard the receiving agent calls on its
input. Free text is confined to two points only: the customer's description
coming *in*, and the notification copy going *out*. Between agents it is
always structured JSON with explicit types (`SkillTag` unions, tier enums,
numeric score components).

The customer booking is validated and clamped at the very edge
(`validateBookingRequest`): email format checked, oversized free-text
truncated to 2000 chars (a token-bomb guard), unknown tiers rejected with a
`[schema:*]` error that the API maps to HTTP 400.

## 4. Autonomy & human-in-the-loop

The core demo. The **freeze window** (`scheduled_time − 3h`, configurable) is
the risk boundary:

- **Before the freeze point** a job is "soft". The Disruption Agent may
  propose moving it. If the recommended re-plan is low-impact — under the
  configured thresholds for customers affected, added travel, SLA breaches —
  it **auto-commits**.
- **Any re-plan that affects a customer** (default: `hitlMaxCustomersAffected
  = 0`) goes to the **Approvals queue**. The coordinator sees 2–3 options with
  quantified trade-offs and the agent's recommendation, picks one, and
  approves — or rejects, and nothing changes.
- **After the freeze point** a job is "frozen". The only way to change it is an
  **Emergency Override**: a distinct, louder approval flow, styled red, that
  records the approver's name against every frozen job it touches. There is no
  automatic path through this gate.

Autonomy is a **dial**, not a switch: the thresholds live in `runtime_config`
and are editable on the Settings screen. Raise `hitlMaxCustomersAffected` and
low-impact moves start auto-committing; the demo shows this live.

## 5. Safety, security & guardrails

- **Prompt injection.** The customer description is untrusted. It reaches the
  LLM only inside a delimited, neutralised frame (`<<<CUSTOMER_TEXT_BEGIN>>>`
  … `END`), with a system instruction to treat everything inside as data. Known
  injection markers are detected and noted. Even on a successful injection the
  structured output is still validated and the pricing is still computed by the
  rule engine — the eval suite asserts a "set price to 0" payload leaves the
  price untouched.
- **Skill matching is a hard constraint, not a soft score.** A technician
  without the matching certification is removed from candidacy *before* scoring
  — this mirrors a real legal constraint (you cannot send an uncertified person
  to handle refrigerant). If no certified technician is free, the system
  **escalates to a human** rather than forcing an assignment.
- **Least privilege.** The Technician-State Agent returns only the fields
  scoring needs — never a technician's phone or home address. The browser uses
  a Supabase anon key with RLS allowing read-only access; all writes go through
  the server with the service-role key.
- **Blast-radius limits.** LLM call budget; input size caps; deterministic slot
  math (the Disruption Agent never invents schedule times, it only ranks
  pre-computed options).

## 6. Observability & evaluation

Every agent writes exactly one row to `agent_decision_log`: which agent, rule
vs LLM, input summary, output summary, score breakdown, candidate ranking,
re-plan options, guardrail notes, latency, and — for approvals — who signed
off. That table is:

- the **Agent Reasoning Feed** on the Admin dashboard (live via Supabase
  Realtime, with a polling fallback), where each row expands to a bar-chart
  score breakdown, the full candidate list with rejection reasons, and the
  Disruption Agent's options side by side;
- the **observability artifact** for this submission.

`scripts/eval.ts` runs a golden-path + adversarial suite — clean assignment,
ambiguous-score tie-break, bump→HITL→approve, reject-keeps-schedule,
edge-case widen-window, and adversarial cases (prompt injection, oversized
input, invalid tier, no-certified-technician). Each scenario re-seeds first
so cases are independent; the run exits non-zero on any failed assertion.

## 7. Platform & tooling

- **Next.js 14** (App Router) — one app hosts all three UIs and the agent API.
- **Supabase** (Postgres + Realtime) behind a single `repo` module; swapping
  the store is confined to that file plus the row↔domain mappers.
- **AWS Bedrock — Claude Sonnet 4.5** for LLM calls; deploys to **AWS
  Lightsail**.
- Multi-agent orchestration is a clean, typed pipeline in `orchestrator.ts` —
  no framework magic, every hand-off visible.

## Known limitations / next steps

- Routing uses straight-line (haversine) distance, not real drive times — kept
  offline-safe and cost-free for the demo; a maps API is a drop-in behind
  `geo.ts`.
- The Capacity Agent combines fleet-wide caps with a per-skill saturation
  forecast (certified technicians × slots/day, and the tight window around the
  requested time); a historical-yield model is the documented next step.
- Manual drag-drop override on the Gantt is not yet wired (view + hover only).
