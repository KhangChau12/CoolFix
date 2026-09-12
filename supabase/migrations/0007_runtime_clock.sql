-- Persist the demo scheduling clock so tomorrow's schedule can be tested
-- across pages and server requests until the coordinator switches back to
-- real time.
alter table runtime_config
  add column if not exists clock_mode text not null default 'real';

alter table runtime_config
  add column if not exists custom_time_iso timestamptz;

alter table runtime_config
  drop constraint if exists runtime_config_clock_mode_check;

alter table runtime_config
  add constraint runtime_config_clock_mode_check
  check (clock_mode in ('real', 'custom'));
