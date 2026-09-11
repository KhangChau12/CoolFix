-- ═══════════════════════════════════════════════════════════════════
-- CoolFix — migration 0004
-- Replaces the flat `score_weights` config with a per-tier `dispatch_policy`.
--
-- Why: the old Assignment Agent score was
--   w1·(1/distance) + w2·skill_match + w3·urgency + w4·(1/workload)
-- where the terms had different units and ranges, so skill_match and
-- urgency were effectively constant offsets that never separated one
-- candidate from another — only distance and workload moved the ranking.
--
-- The new scoring (src/agents/scoring.ts) uses five components, each
-- normalised to [0,1]: travel fit, skill fit, availability, SLA headroom,
-- load balance. `dispatch_policy` holds the weight of each component PER
-- TIER (each tier's five weights sum to 1), so a coordinator can express
-- "urgent = speed + the right person" vs "flexible = spread the work".
--
-- score_breakdown columns (jobs, agent_decision_log) are jsonb and don't
-- change shape here — the app writes the new five-field object into them.
--
-- Run this in the Supabase SQL Editor after 0003. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════

-- 1. New column with the shipped default policy.
alter table runtime_config
  add column if not exists dispatch_policy jsonb not null default '{
    "urgent":   {"travel":0.42,"skillFit":0.28,"availability":0.12,"slaHeadroom":0.18,"loadBalance":0.00},
    "priority": {"travel":0.34,"skillFit":0.26,"availability":0.15,"slaHeadroom":0.12,"loadBalance":0.13},
    "standard": {"travel":0.28,"skillFit":0.22,"availability":0.17,"slaHeadroom":0.05,"loadBalance":0.28},
    "flexible": {"travel":0.22,"skillFit":0.18,"availability":0.18,"slaHeadroom":0.02,"loadBalance":0.40}
  }'::jsonb;

-- 2. Make sure the single config row actually carries the default (a row
--    that existed before this migration keeps the column default, but be
--    explicit for any row where it somehow came through null/empty).
update runtime_config
set dispatch_policy = '{
    "urgent":   {"travel":0.42,"skillFit":0.28,"availability":0.12,"slaHeadroom":0.18,"loadBalance":0.00},
    "priority": {"travel":0.34,"skillFit":0.26,"availability":0.15,"slaHeadroom":0.12,"loadBalance":0.13},
    "standard": {"travel":0.28,"skillFit":0.22,"availability":0.17,"slaHeadroom":0.05,"loadBalance":0.28},
    "flexible": {"travel":0.22,"skillFit":0.18,"availability":0.18,"slaHeadroom":0.02,"loadBalance":0.40}
  }'::jsonb
where dispatch_policy is null
   or jsonb_typeof(dispatch_policy) <> 'object'
   or not (dispatch_policy ? 'urgent');

-- 3. Drop the obsolete flat weights. The app no longer reads score_weights;
--    rowToConfig() falls back to the shipped DISPATCH_POLICY if the new
--    column is ever missing, so this is purely tidy-up.
alter table runtime_config
  drop column if exists score_weights;

-- 4. Index: the Assignment Agent's route-feasibility check reads a
--    technician's other jobs for the same day, keyed by technician + time.
--    jobs_tech_idx (technician) and jobs_sched_idx (scheduled_time) already
--    exist from 0001; a composite helps the common "this tech, this day"
--    lookup the scoring pass now does for every candidate.
create index if not exists jobs_tech_sched_idx
  on jobs (assigned_technician_id, scheduled_time);
