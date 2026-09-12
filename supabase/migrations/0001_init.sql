-- ═══════════════════════════════════════════════════════════════════
-- CoolFix — schema
-- Run this in the Supabase SQL Editor (or `supabase db push`).
-- Realtime: enable replication for `agent_decision_log` (and optionally
-- jobs / approval_requests) — see the ALTER PUBLICATION block at the end.
-- ═══════════════════════════════════════════════════════════════════

-- ── Enums ──────────────────────────────────────────────────────────
do $$ begin
  create type skill_tag as enum
    ('basic_maintenance','refrigerant_handling','electrical_work','commercial_chiller');
exception when duplicate_object then null; end $$;

do $$ begin
  create type tier as enum ('urgent','priority','standard','flexible');
exception when duplicate_object then null; end $$;

do $$ begin
  create type job_status as enum
    ('pending','assigned','frozen','in_progress','completed','disrupted');
exception when duplicate_object then null; end $$;

do $$ begin
  create type pipeline_stage as enum
    ('intake','pricing','capacity_check','scoring','assigned',
     'disruption_review','awaiting_approval','done');
exception when duplicate_object then null; end $$;

do $$ begin
  create type agent_name as enum
    ('PricingEngine','JobIntakeAgent','CapacityAgent','TechnicianStateAgent',
     'AssignmentAgent','DisruptionAgent','NotificationAgent','Orchestrator');
exception when duplicate_object then null; end $$;

do $$ begin
  create type decision_outcome as enum
    ('auto_commit','requires_approval','approved','rejected','info');
exception when duplicate_object then null; end $$;

do $$ begin
  create type approval_kind as enum ('standard','emergency_override');
exception when duplicate_object then null; end $$;

do $$ begin
  create type approval_status as enum ('pending','approved','rejected');
exception when duplicate_object then null; end $$;

do $$ begin
  create type notification_channel as enum ('technician_app','customer_email');
exception when duplicate_object then null; end $$;

-- ── Technicians ────────────────────────────────────────────────────
create table if not exists technicians (
  technician_id      text primary key,
  name               text not null,
  photo_url          text not null default '',
  skill_tags         skill_tag[] not null default '{}',
  experience_level   text not null check (experience_level in ('junior','senior')),
  location           jsonb not null,               -- {lat,lng}
  working_hours      jsonb not null,               -- {start,end}
  current_workload   int  not null default 0,
  phone              text not null default '',
  created_at         timestamptz not null default now()
);

-- ── Jobs ──────────────────────────────────────────────────────────
create table if not exists jobs (
  job_id                  text primary key,
  customer_name           text not null,
  customer_email          text not null,
  customer_phone          text not null default '',
  location                jsonb not null,           -- {lat,lng,address}
  problem_description     text not null,
  problem_category        text not null default '',
  photo_url               text,
  skill_required          skill_tag[] not null default '{}',
  tier                    tier not null,
  scheduled_time          timestamptz not null,
  freeze_point            timestamptz not null,
  status                  job_status not null default 'pending',
  assigned_technician_id  text references technicians(technician_id),
  score_breakdown         jsonb,
  price                   numeric not null default 0,
  created_at              timestamptz not null default now(),
  pipeline_stage          pipeline_stage not null default 'intake',
  reschedule_history      jsonb not null default '[]'
);
create index if not exists jobs_status_idx on jobs(status);
create index if not exists jobs_sched_idx  on jobs(scheduled_time);
create index if not exists jobs_tech_idx   on jobs(assigned_technician_id);

-- ── Agent decision log (Observability spine) ──────────────────────
create table if not exists agent_decision_log (
  log_id                  text primary key,
  timestamp               timestamptz not null default now(),
  agent_name              agent_name not null,
  job_id                  text not null,
  reasoning_kind          text not null check (reasoning_kind in ('llm','rule')),
  input_summary           jsonb not null default '{}',
  output_summary          jsonb not null default '{}',
  score_breakdown         jsonb,
  candidates              jsonb,
  replan_options          jsonb,
  requires_human_approval boolean not null default false,
  outcome                 decision_outcome not null,
  approved_by             text,
  headline                text not null,
  latency_ms              int not null default 0,
  guardrail_notes         jsonb not null default '[]'
);
create index if not exists adl_ts_idx  on agent_decision_log(timestamp desc);
create index if not exists adl_job_idx on agent_decision_log(job_id);

-- ── Approval requests (HITL) ─────────────────────────────────────
create table if not exists approval_requests (
  approval_id           text primary key,
  created_at            timestamptz not null default now(),
  kind                  approval_kind not null,
  job_id                text not null,
  reason                text not null,
  disruption_log_id     text not null,
  options               jsonb not null default '[]',
  chosen_option_id      text,
  status                approval_status not null default 'pending',
  resolved_by           text,
  resolved_at           timestamptz,
  frozen_jobs_impacted  jsonb not null default '[]'
);
create index if not exists ar_status_idx on approval_requests(status);

-- ── Notifications (two-way) ─────────────────────────────────────
create table if not exists notifications (
  notification_id   text primary key,
  created_at        timestamptz not null default now(),
  channel           notification_channel not null,
  recipient_id      text not null,
  job_id            text not null,
  kind              text not null,
  subject           text not null,
  body              text not null,
  acknowledged      boolean not null default false,
  acknowledged_at   timestamptz
);
create index if not exists ntf_recipient_idx on notifications(recipient_id);
create index if not exists ntf_job_idx on notifications(job_id);

-- ── Runtime config (single row) ────────────────────────────────
create table if not exists runtime_config (
  id                          int primary key default 1 check (id = 1),
  freeze_window_hours         numeric not null default 3,
  clock_mode                  text not null default 'real' check (clock_mode in ('real', 'custom')),
  custom_time_iso             timestamptz,
  score_weights               jsonb not null default '{"w1":1.0,"w2":2.0,"w3":1.5,"w4":1.0}',
  hitl_max_customers_affected int not null default 1,
  hitl_max_added_travel_km    numeric not null default 8,
  capacity_flexible_per_day   int not null default 6,
  capacity_total_per_day      int not null default 24,
  base_price                  jsonb not null default
    '{"basic_maintenance":80,"refrigerant_handling":160,"electrical_work":180,"commercial_chiller":320}',
  llm_mode                    text not null default 'stub',
  updated_at                  timestamptz not null default now()
);
insert into runtime_config (id) values (1) on conflict (id) do nothing;

-- ── RLS ────────────────────────────────────────────────────────
-- Demo app: the server uses the service_role key (bypasses RLS) for all
-- writes. The browser uses the anon key for read-only realtime + fetch.
-- So: enable RLS, allow anon SELECT, deny anon writes.
alter table technicians          enable row level security;
alter table jobs                 enable row level security;
alter table agent_decision_log   enable row level security;
alter table approval_requests    enable row level security;
alter table notifications        enable row level security;
alter table runtime_config       enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'technicians','jobs','agent_decision_log','approval_requests',
    'notifications','runtime_config'
  ] loop
    execute format(
      'drop policy if exists "anon read %1$s" on %1$s;', t);
    execute format(
      'create policy "anon read %1$s" on %1$s for select using (true);', t);
  end loop;
end $$;

-- ── Realtime ───────────────────────────────────────────────────
-- Add the tables the Admin UI subscribes to.
do $$ begin
  alter publication supabase_realtime add table agent_decision_log;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table jobs;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table approval_requests;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table notifications;
exception when duplicate_object then null; end $$;
