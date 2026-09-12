-- ═══════════════════════════════════════════════════════════════════
-- CoolFix — migration 0006
-- Customer feedback + technician performance.
--
-- 1. New table `job_feedback` — one row per completed job, submitted by
--    the customer through their public tracking token. A unique index on
--    job_id is the actual duplicate-submission guard (not just an app-level
--    check): two concurrent inserts for the same job race at the database,
--    exactly one wins, the loser gets a clean 23505 the API turns into a
--    safe "already submitted" response.
--
-- 2. `runtime_config.dispatch_policy` gains a sixth component,
--    `customerSatisfaction`, on every tier — a small (5%) default weight,
--    added on top of (not replacing) whatever a coordinator already
--    customised. Existing rows are merged, not overwritten wholesale, so a
--    live deployment's tuned policy survives this migration.
--
-- No existing column, type, or row is destroyed. Safe to run against a DB
-- that already has real jobs/technicians/config data.
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. job_feedback ──────────────────────────────────────────────────
create table if not exists job_feedback (
  feedback_id       text primary key,
  job_id            text not null references jobs(job_id),
  technician_id     text not null references technicians(technician_id),
  rating            int  not null check (rating between 1 and 5),
  positive_tags     text[] not null default '{}',
  improvement_tags  text[] not null default '{}',
  comment           text,
  created_at        timestamptz not null default now()
);

-- The actual "one feedback per job" guarantee — enforced by Postgres, not
-- just app logic, so a race between two concurrent submissions can never
-- produce two rows.
create unique index if not exists job_feedback_job_id_idx
  on job_feedback(job_id);
create index if not exists job_feedback_tech_idx
  on job_feedback(technician_id);

alter table job_feedback enable row level security;
drop policy if exists "anon read job_feedback" on job_feedback;
create policy "anon read job_feedback" on job_feedback for select using (true);

do $$ begin
  alter publication supabase_realtime add table job_feedback;
exception when duplicate_object then null; end $$;

-- ── 2. dispatch_policy: add customerSatisfaction, keep existing tuning ──
-- Merge (not replace) — a tier row that already has the key is untouched;
-- one that doesn't gets +0.05. jsonb `||` overwrites only the keys given.
update runtime_config
set dispatch_policy = (
  select jsonb_object_agg(
    tier,
    case
      when tier_policy ? 'customerSatisfaction' then tier_policy
      else tier_policy || '{"customerSatisfaction": 0.05}'::jsonb
    end
  )
  from jsonb_each(dispatch_policy) as t(tier, tier_policy)
)
where dispatch_policy is not null
  and jsonb_typeof(dispatch_policy) = 'object';
