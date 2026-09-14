-- ═══════════════════════════════════════════════════════════════════
-- CoolFix — migration 0008
-- Customer-feedback-driven adaptive dispatch policy.
--
-- This is deliberately recommendation-first. Feedback never writes a
-- dispatch weight directly: a recommendation is stored, reviewed, and only
-- then applied through the server-side policy-version check.
--
-- The app has no authentication or tenant table yet, so company_id is an
-- explicit demo scope. It is a seam for a future real company_id, not tenant
-- isolation.
-- ═══════════════════════════════════════════════════════════════════

-- ── Versioned policy snapshots ─────────────────────────────────────
alter table runtime_config
  add column if not exists policy_version text not null default 'policy-v1';

alter table runtime_config
  add column if not exists adaptive_policy_enabled boolean not null default false;

alter table runtime_config
  add column if not exists adaptive_policy_mode text not null default 'recommendation_only';

alter table runtime_config
  add column if not exists adaptive_min_feedback_count int not null default 20;

alter table runtime_config
  add column if not exists adaptive_min_unique_technicians int not null default 3;

alter table runtime_config
  add column if not exists adaptive_max_change numeric not null default 0.02;

alter table runtime_config
  add column if not exists adaptive_cooldown_days int not null default 14;

alter table runtime_config
  add column if not exists adaptive_min_confidence numeric not null default 0.75;

alter table runtime_config
  add column if not exists adaptive_max_customer_satisfaction_weight numeric not null default 0.15;

alter table runtime_config
  drop constraint if exists runtime_config_adaptive_policy_mode_check;

alter table runtime_config
  add constraint runtime_config_adaptive_policy_mode_check
  check (adaptive_policy_mode in ('recommendation_only', 'automatic'));

alter table jobs
  add column if not exists dispatch_policy_version text;

alter table jobs
  add column if not exists dispatch_policy_snapshot jsonb;

alter table agent_decision_log
  add column if not exists policy_version text;

alter table agent_decision_log
  add column if not exists dispatch_policy_snapshot jsonb;

update jobs
set dispatch_policy_version = (select policy_version from runtime_config where id = 1),
    dispatch_policy_snapshot = (select dispatch_policy from runtime_config where id = 1)
where dispatch_policy_version is null;

-- ── Feedback moderation / privacy-preserving submission metadata ─────
alter table job_feedback
  add column if not exists source_hash text;

alter table job_feedback
  add column if not exists flagged boolean not null default false;

alter table job_feedback
  add column if not exists excluded_from_adaptation boolean not null default false;

alter table job_feedback
  add column if not exists flag_reason text;

create index if not exists job_feedback_adaptation_idx
  on job_feedback(excluded_from_adaptation, created_at desc);

-- Short-lived hashes only. Raw IP addresses and user-agent strings are never
-- stored. A scheduled cleanup can remove old rows in a production deployment.
create table if not exists feedback_submission_attempts (
  attempt_id          text primary key,
  tracking_token_hash text not null,
  source_hash         text not null,
  session_hash        text,
  created_at          timestamptz not null default now()
);
create index if not exists feedback_attempt_source_idx
  on feedback_submission_attempts(source_hash, created_at desc);
create index if not exists feedback_attempt_token_idx
  on feedback_submission_attempts(tracking_token_hash, created_at desc);

-- ── Adaptive recommendations ──────────────────────────────────────
create table if not exists adaptive_policy_recommendations (
  recommendation_id       text primary key,
  company_id              text not null default 'demo-company',
  tier                    tier not null,
  current_policy          jsonb not null,
  proposed_policy         jsonb not null,
  changes                 jsonb not null default '[]',
  supporting_metrics      jsonb not null default '{}',
  sample_count            int not null default 0,
  unique_technician_count int not null default 0,
  confidence              numeric not null default 0,
  explanation             text not null,
  limitations             jsonb not null default '[]',
  included_feedback_ids   jsonb not null default '[]',
  excluded_feedback_ids   jsonb not null default '[]',
  status                  text not null default 'pending'
    check (status in ('pending','approved','rejected','applied','rolled_back')),
  created_at              timestamptz not null default now(),
  approved_at             timestamptz,
  applied_at              timestamptz,
  applied_by              text,
  previous_policy_version text not null,
  new_policy_version      text,
  source                  text not null default 'rule'
    check (source in ('rule','ai_recommendation','manual'))
);
create index if not exists adaptive_recommendation_status_idx
  on adaptive_policy_recommendations(company_id, status, created_at desc);
create index if not exists adaptive_recommendation_tier_idx
  on adaptive_policy_recommendations(company_id, tier, created_at desc);

create table if not exists adaptive_policy_change_history (
  change_id             text primary key,
  recommendation_id     text,
  company_id            text not null default 'demo-company',
  tier                  tier not null,
  before_policy         jsonb not null,
  after_policy          jsonb not null,
  reason                text not null,
  supporting_metrics    jsonb not null default '{}',
  feedback_ids          jsonb not null default '[]',
  approved_by           text,
  change_mode           text not null check (change_mode in ('automatic','manual','rollback')),
  created_at            timestamptz not null default now(),
  rollback_of_change_id text
);
create index if not exists adaptive_history_tier_idx
  on adaptive_policy_change_history(company_id, tier, created_at desc);

alter table feedback_submission_attempts enable row level security;
alter table adaptive_policy_recommendations enable row level security;
alter table adaptive_policy_change_history enable row level security;

drop policy if exists "anon read adaptive recommendations" on adaptive_policy_recommendations;
create policy "anon read adaptive recommendations"
  on adaptive_policy_recommendations for select using (true);

drop policy if exists "anon read adaptive history" on adaptive_policy_change_history;
create policy "anon read adaptive history"
  on adaptive_policy_change_history for select using (true);

do $$ begin
  alter publication supabase_realtime add table adaptive_policy_recommendations;
exception when duplicate_object then null; end $$;
