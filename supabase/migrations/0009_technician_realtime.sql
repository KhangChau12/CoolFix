-- The technicians screen subscribes to this table, but previous migrations
-- published jobs/feedback only. Preserve all data, RLS policies and tables.
-- Run after 0001..0008. Safe to re-run.
do $$ begin
  alter publication supabase_realtime add table public.technicians;
exception when duplicate_object then null; end $$;

-- Refresh the REST schema cache after applying the migration sequence.
notify pgrst, 'reload schema';
