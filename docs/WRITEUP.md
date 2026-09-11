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
Job-Intake Agent ......... LLM       free-text → {skill_required[], urgency, time window}
   ▼
Pricing Engine ........... rule      base_price[skill] × tier_multiplier — priced ONCE, after
   │                                 intake, on the real required skills (no provisional pass)
   ▼
Capacity/Yield Agent ..... rule      daily fleet thresholds + per-skill saturation forecast
   ▼
Technician-State Agent ... rule      roster + location + load (state store, least-privilege)
   ▼
Assignment/Scoring Agent . rule      4 hard filters (certification, working hours, no clash,
   │                                 route feasibility) then a 5-component weighted score,
   │                                 each component ∈ [0,1], per-tier policy weights → match ∈ [0,1]
   ▼
Assignment Tie-break ..... LLM       ambiguity-only: close scores / one strained candidate /
   │                                 urgent with no strong fit. Picks within the eligible
   │                                 top-3; the pick is re-scored against live state before
   │                                 commit. Unambiguous ranking → this agent never runs.
   │
   ├─ technician free, no conflict ──────────→ auto-commit → Notification Agent (LLM)
   │
   ├─ NO eligible technician (and no bump) ──→ Assignment Edge-case Agent (LLM)
   │                                            picks one pre-validated lever:
   │                                            widen_window (auto-commit) /
   │                                            split_visit · pair_junior_senior (→ HITL) /
   │                                            escalate (→ coordinator)
   │
   └─ conflict — urgent job must bump a soft job ──→ Disruption Agent (LLM: DESIGNS the re-plan)
                                                       ├─ low impact, every safety rail clear ─→ auto-commit
                                                       ├─ impact over threshold ───────────────→ HITL Approval Gate
                                                       └─ every option would touch a frozen job ─→ no re-plan proposed;
                                                                                                   job reported unassignable
```

Nine agents total: Job-Intake, Pricing, Capacity, Technician-State,
Assignment/Scoring, Assignment Tie-break, Assignment Edge-case, Disruption,
Notification — orchestrated by a typed pipeline in `orchestrator.ts`.

**State management.** One booking = one `AgentContext`. It loads the
technician roster, the job list and config **once**, so the scoring pass
doesn't fan out into dozens of database round-trips; it buffers every
decision-log row and every job write, and flushes them in a deterministic
order at the end. The reasoning loop's state is explicit and inspectable, not
smeared across ad-hoc queries.

**How a technician is chosen (`src/agents/scoring.ts`).** For each booking the
Assignment Agent first removes anyone who fails a hard constraint — wrong
certification, off-shift, already booked within ±90 min, or physically unable
to reach the job from their previous stop in time — then scores everyone left
on five components, each a pure function returning `[0, 1]`:

- **travel** — the *marginal* driving minutes this job adds to the
  technician's route today (the detour between the job before it and the job
  after it), not the straight-line distance from a depot. A job on the way
  costs almost nothing; a job that doubles back costs a wasted hour.
- **skillFit** — certification is already a hard filter, so this scores the
  right *seniority for the job's complexity* (a chiller plant wants a senior;
  routine servicing does not), minus a small penalty for over-qualification.
- **availability** — hours left in the technician's shift after this job, from
  real per-skill duration estimates — a 45-minute clean and a 3-hour chiller
  job are not the same "one job".
- **slaHeadroom** — how close the job is to its tier deadline; and `0` for any
  technician whose schedule would make it miss that deadline.
- **loadBalance** — pulls work toward technicians below the fleet's median
  utilisation for the day.

`travel` and `availability` are min-max ranked *within the candidate pool for
that job*, so they always separate candidates — the old additive formula
(`w1·(1/dist) + w2·skill + w3·urgency + w4·(1/workload)`) had terms on
different scales, so skill and urgency were near-constant offsets that never
changed who got picked. The final score is
`Σ policy[tier][k] · component_k`, where each tier's five policy weights sum
to 1 — so the score is itself in `[0, 1]` and reads as a match percentage.
**The per-tier policy is the business lever**: urgent leans on travel, skill
and deadline; flexible leans on load balance. It is editable in Settings, with
the formula and a plain-language rationale for each component shown alongside.

**Why some agents are not LLMs — a deliberate decision.** Pricing, capacity,
technician-state and the scoring engine above are pure rules / bookkeeping.
Putting an LLM there would add latency, cost, and non-determinism for zero
benefit, and would make the system *less* trustworthy. LLMs are used only
where genuine judgement is needed — and even then, the rule layer bounds
what the LLM can choose from and re-checks what it picked:

| Agent | LLM? | Why / how it's bounded |
|---|---|---|
| Job-Intake | **yes** | interpreting a customer's free-text symptom description |
| Pricing | no | `base_price[skill] × tier_multiplier` — must be exact and free |
| Capacity | no | fleet threshold + per-skill saturation, both deterministic |
| Technician-State | no | a database query |
| Assignment/Scoring | no | a transparent weighted-sum of five components, each ∈ [0,1], with per-tier policy weights — auditable by design and reproducible |
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
- `LLM_MODE=gateway` — **the hackathon provider**: the organisers' self-hosted
  AWS LLM gateway. Ollama-compatible `POST /api/chat`, `X-API-Key` auth,
  Claude Sonnet 4.5 (`global.anthropic.claude-sonnet-4-5-...`) on AWS behind
  it. The gateway has no JSON mode and no native tool-calling — neither
  matters here, because every agent already asks for minified JSON in its
  system prompt and the parser tolerates the ```json fence the gateway adds.
  A transport-level linear backoff (3s / 6s / 9s) covers the gateway's
  429/403-on-burst behaviour.
- `LLM_MODE=openai` — OpenAI Chat Completions over plain `fetch` (no extra
  SDK), `response_format: json_object`; kept as a dev fallback provider.

A per-process call budget hard-stops runaway loops, results are cached by
input hash so re-running a demo step is free, and a bounded single retry
covers a malformed-JSON response only — never a constraint-invalid one, which
falls back deterministically instead. `/api/health` reports the active mode
and whether its credentials are present.

**Provider portability, verified.** The full eval suite has been run against
the live gateway, not just the stub. The pipeline structure holds — schema
validation, guardrails, HITL gating, the injection defence and the
deterministic fallbacks all behave identically. What *does* change is the
model's judgement inside the space it is given: the real Claude sometimes
designs a re-plan the fixtures wouldn't (e.g. a next-day slot instead of a
tight same-day shift), and the rule layer then routes it to a human because
it breaks a safety rail — exactly as intended. The stub is the deterministic
demo path; the gateway is the real one, and the guardrails are what make the
difference between them safe.

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

For the Disruption and Edge-case agents the schema is stricter still: the LLM
is handed a **pre-verified legal space** (allowed technician × slot pairs, all
hard constraints already applied) and may only return references *into* that
space — a plan is `{job_id, to_tech_id, to_slot_iso}` where every value must
appear verbatim in the space it was given. The LLM cannot emit a slot, a
technician, or a trade-off number of its own.

## 4. Autonomy & human-in-the-loop

The core demo. The **freeze window** (`scheduled_time − 2h`, configurable) is
the risk boundary:

- **Before the freeze point** a job is "soft". The Disruption Agent may
  design a re-plan that moves it. The recommended re-plan **auto-commits**
  only when it clears *every* safety rail — otherwise it goes to the
  coordinator.
- **After the freeze point** a job is "frozen". It is an **absolute
  constraint**. The pipeline treats a frozen appointment as already having
  happened: no agent — rule or LLM — may propose touching it. If every
  candidate re-plan for an incoming job would have to move a frozen job, the
  Disruption Agent proposes **nothing** and the incoming job is reported
  unassignable, so the customer picks a different time. There is no automatic
  path through the freeze window. (See §5, "design decision".)

### The auto-commit safety rails

A re-plan skips the human only when **all** of these hold
(`disruption.ts` → `replanQualifiesForAutoCommit`):

| Rail | Value | Source |
|---|---|---|
| Customers affected | ≤ `hitlMaxCustomersAffected` (**default 1**) | `runtime_config`, editable in Settings |
| Added travel | ≤ `hitlMaxAddedTravelKm` (default 8 km) | `runtime_config`, editable in Settings |
| SLA breaches | 0 | fixed |
| Moved-job tier | Flexible only | `AUTO_REPLAN_LIMITS`, fixed |
| Total time shift | ≤ 3 h | `AUTO_REPLAN_LIMITS`, fixed |
| Gap to neighbouring job | ≥ 2 h | `AUTO_REPLAN_LIMITS`, fixed |
| Prior reschedules of that job | 0 | `AUTO_REPLAN_LIMITS`, fixed |
| Same calendar day (SGT) | required | fixed |
| Moved job's new slot | outside its own freeze window | fixed |

`hitlMaxCustomersAffected = 1` is the tunable that gives the Disruption Agent
real autonomy: a genuinely low-impact move — one Flexible customer, same day,
a couple of hours, comfortable buffer — is committed automatically, with the
audit row recording `decided_by = "auto"`. Anything larger, anything that
touches a Standard/Priority customer, or any single rail broken, and the
pipeline **stops** and raises an approval. The coordinator sees the 2–3 plans
the agent designed, each with quantified trade-offs and the agent's
recommendation, and picks one — or rejects, and nothing changes.

Set `hitlMaxCustomersAffected` to 0 on the Settings screen and *every*
customer-visible move goes to the queue; raise it and the auto-commit
envelope grows. **Autonomy is a dial the coordinator owns, not a fixed
property of the system** — and the demo shows both ends of it live.

The approval record's `kind` field still carries the value
`"emergency_override"` in the type so the DB schema is stable, but the
pipeline never produces it — see §5.

## 5. Safety, security & guardrails

- **Prompt injection.** The customer description is untrusted. It reaches the
  LLM only inside a delimited, neutralised frame (`<<<CUSTOMER_TEXT_BEGIN>>>`
  … `END`), with a system instruction to treat everything inside as data. Known
  injection markers are detected and noted in the guardrail log. Even on a
  successful injection the structured output is still validated and the
  pricing is still computed by the rule engine — the eval suite asserts a
  "set price to 0" payload leaves the price untouched and the Job-Intake row
  flags `injection_attempt`.
- **Skill matching is a hard constraint, not a soft score.** A technician
  without the matching certification is removed from candidacy *before* scoring
  — this mirrors a real legal constraint (you cannot send an uncertified person
  to handle refrigerant). If no certified technician is free, the Edge-case
  Agent tries a small set of pre-validated levers and, failing those, the
  system **escalates to a human** rather than forcing an assignment.
- **Freeze window is absolute — a deliberate design decision.** An earlier
  design had an "Emergency Override" flow that let an urgent job break a
  frozen appointment with a louder approval. We removed it from the automatic
  pipeline: a frozen appointment is treated as already-in-progress, and no
  agent path proposes touching it. The freeze check runs at *two* layers
  (candidate generation and post-LLM re-validation) through one shared
  function, so the two can't drift. A coordinator can still hand-edit a
  frozen job outside this pipeline in a genuine emergency (a technician calls
  in sick) — but that is a separate human action, not something an agent
  offers.
- **The LLM is never trusted blindly.** Every choice it makes passes two
  layers: (a) a cross-check that its referenced ids/slots exist in the space
  it was given, and (b) an independent re-validation of all hard constraints
  against live state. Fail either and the pipeline falls back to the best
  pre-computed deterministic option, with the reason written to the guardrail
  notes.
- **Least privilege.** The Technician-State Agent returns only the fields
  scoring needs — never a technician's phone or home address. The browser uses
  a Supabase anon key with RLS allowing read-only access; all writes go through
  the server with the service-role key.
- **Location is validated, not trusted.** The customer picks their address on
  a map that geocodes it to a coordinate client-side, but the server re-checks
  every booking's `{ lat, lng }` against a Singapore bounding box at the schema
  boundary and rejects anything outside it — a malformed, out-of-range, or
  injected coordinate never reaches the routing score.
- **Blast-radius limits.** LLM call budget; input size caps; deterministic slot
  math (the Disruption Agent never invents schedule times, it only picks from
  pre-computed legal slots).

## 6. Observability & evaluation

Every agent writes exactly one row to `agent_decision_log`: which agent, rule
vs LLM, input summary, output summary, score breakdown, candidate ranking,
re-plan options, guardrail notes, latency, and — for approvals — who signed
off. That table is:

- the **Agent Reasoning Feed** on the Admin dashboard (live via Supabase
  Realtime, with a polling fallback), where rows are grouped by booking and
  each expands to a bar-chart score breakdown, the full candidate list with
  rejection reasons, and the Disruption Agent's plans side by side. Each row
  carries a **LLM AGENT / RULE ENGINE** badge so the cost discipline is
  visible at a glance;
- the **per-job pipeline replay** at `/admin/jobs/[id]` — the whole decision
  timeline for one job in pipeline order, plus its notification acks;
- the **customer-facing tracker** (`/book`) — a six-step, plain-language
  version of the same pipeline ("Understanding your problem" → "Sending your
  confirmation"), with no internal detail leaked;
- the **observability artifact** for this submission.

`scripts/eval.ts` runs a golden-path + adversarial suite — **10 scenarios,
48 assertions**, re-seeding before each so cases are independent, exiting
non-zero on any failure:

| Scenario | What it proves |
|---|---|
| Clean standard booking | end-to-end auto-assign, score breakdown present, both parties notified |
| Urgent bump → HITL → approve | Disruption Agent designs ≥2 re-validated plans; gate holds (0 notifications) until a coordinator approves; audit records the coordinator's name; no double-booking |
| Low-impact re-plan → auto-commit | every safety rail clears; bumped job moves same-day; audit records `decided_by = "auto"`; no approval raised |
| Coordinator rejects re-plan | nothing changes — schedule and reschedule history untouched |
| Ambiguous score → tie-break | tie-break agent fires only on genuine ambiguity, its pick is re-scored and certified (skipped, not failed, when the formula is unambiguous for that run's slot) |
| No slot at the ideal time → edge-case widen | edge-case agent widens the window to a genuinely free *certified* technician; no Disruption Agent involved |
| Adversarial: prompt injection | price not zeroed, skill still correct, `injection_attempt` flagged |
| Adversarial: oversized description | pipeline completes, stored text truncated to 2000 chars |
| Adversarial: invalid tier | rejected at the schema boundary |
| Adversarial: no certified technician | never force-assigns — widens to a certified tech, proposes a supervised pair, or escalates |

Three further probes back the eval, each re-seeding per case and exiting
non-zero on a violation:

- **`scripts/robustness.ts`** — mocks the wall clock and runs the
  demo-critical scenarios at every hour of the SGT day. It exists because an
  earlier version of the slot maths let the "low-impact re-plan → the agent
  auto-commits" path silently flip to HITL when the demo ran mid-afternoon
  (the same-day re-plan window had collapsed against a hard 17:00 snap). The
  fix — a wider dispatch window for the *search*, with the technician's real
  working hours still the hard gate, and an urgent booking that rolls to the
  next day rather than landing too late for a same-day re-plan — is now
  regression-tested across the whole day.
- **`scripts/fuzz.ts`** — unusual-but-valid bookings (emoji, 3k-char text,
  HTML, JSON-shaped payloads, contradictory urgency, category/description
  mismatch) against the invariants that must always hold: price > 0, every
  assigned technician certified, a valid schedule instant, no agent-created
  double-booking, the frozen job untouched.
- **`scripts/concurrency.ts`** — several bookings fired with `Promise.all`.
  One `AgentContext` is one snapshot of the schedule loaded up front, so two
  overlapping runs could hand the same slot to two jobs. `runBookingPipeline`
  now serializes itself with an in-process queue (correct for the
  single-process Lightsail deploy); this probe is the guard.

## 7. Platform & tooling

- **Next.js 14** (App Router) — one app hosts all three UIs and the agent API.
- **Supabase** (Postgres + Realtime) behind a single `repo` module; swapping
  the store is confined to that file plus the row↔domain mappers. Supabase is
  an external managed DB, not a deployment target — the app itself runs on
  AWS.
- **Claude Sonnet 4.5** via the competition's self-hosted AWS LLM gateway
  (`LLM_MODE=gateway`); deploys to **AWS Lightsail**.
- Multi-agent orchestration is a clean, typed pipeline in `orchestrator.ts` —
  no framework magic, every hand-off visible.

## Known limitations / next steps

- The customer picks their address on a real map (Leaflet + OpenStreetMap
  tiles, geocoded via Nominatim), and the live booking tracker shows the
  customer pin, the assigned technician, and the straight-line distance
  between them. This is all client-side and degrades gracefully — if Leaflet,
  the tiles, or the geocoder are unreachable, the form falls back to a fixed
  list of area landmarks and the tracker to a plain address card. The backend
  contract is unchanged: it receives a validated `{ lat, lng }` either way.
- Routing uses straight-line (haversine) distance on those coordinates, not
  real drive times — kept offline-safe and cost-free for the demo; a
  distance-matrix API is a drop-in behind `geo.ts`.
- The Capacity Agent combines fleet-wide caps with a per-skill saturation
  forecast (certified technicians × slots/day, and the tight window around the
  requested time). A historical-yield model, and an LLM tier for the
  ambiguous cases (the same "rule enumerates → LLM picks → rule re-validates"
  pattern as the tie-break agent), are the documented next steps.
- All schedule changes flow through an agent or the HITL gate by design;
  manual drag-drop override on the Gantt is intentionally *not* wired (view +
  hover only), to keep every change inside the audited path. A guarded
  coordinator-initiated override is a possible future addition.
- The booking pipeline serializes itself in-process, which is correct for the
  single-instance Lightsail deploy. A horizontally-scaled deployment would
  need a database-level lock or an optimistic pre-flush re-check of the
  chosen slot instead — a small, well-isolated change in `orchestrator.ts`.
