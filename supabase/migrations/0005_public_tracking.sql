-- ═══════════════════════════════════════════════════════════════════
-- CoolFix — customer tracking token
-- Smallest safe addition on top of 0001-0004: a public tracking token per
-- job (the access mechanism for GET /api/public/jobs/:token) and an
-- optional technician sub-status ("en_route" | "arrived") so the public
-- tracker can distinguish those two states — today PATCH /api/jobs/:id
-- collapses both into job_status = 'in_progress'.
--
-- No existing column, type or policy is touched. Safe to run against a
-- DB that already has real data; existing rows are backfilled below.
-- ═══════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

alter table jobs add column if not exists public_tracking_token text;
alter table jobs add column if not exists tech_substatus text;

do $$ begin
  alter table jobs add constraint jobs_tech_substatus_check
    check (tech_substatus is null or tech_substatus in ('en_route', 'arrived'));
exception when duplicate_object then null; end $$;

-- Backfill any pre-existing row that predates this migration. Format
-- mirrors what the app generates going forward (src/lib/trackingToken.ts):
-- "CF-XXXX-XXXX-XXXX" over a 32-symbol alphabet that drops visually
-- ambiguous characters (0/O, 1/I/L). One-time, small demo dataset — a
-- theoretical collision would fail the unique index below and can be
-- re-run safely (it only touches rows still missing a token).
do $$
declare
  r record;
  alphabet text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  token text;
  part text;
  i int;
  j int;
begin
  for r in select job_id from jobs where public_tracking_token is null loop
    token := 'CF';
    for i in 1..3 loop
      part := '';
      for j in 1..4 loop
        part := part || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
      end loop;
      token := token || '-' || part;
    end loop;
    update jobs set public_tracking_token = token where job_id = r.job_id;
  end loop;
end $$;

alter table jobs alter column public_tracking_token set not null;

create unique index if not exists jobs_public_tracking_token_idx
  on jobs(public_tracking_token);
