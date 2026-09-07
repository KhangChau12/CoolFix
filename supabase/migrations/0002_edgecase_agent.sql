-- ═══════════════════════════════════════════════════════════════════
-- CoolFix — migration 0002
-- Adds the Assignment Edge-case Agent to the agent_name enum.
-- The Disruption Agent's LLM output shape changed (it now designs plans
-- rather than picking from a menu) but that lives entirely inside the
-- `replan_options` jsonb column, so no column change is needed here.
-- Run this in the Supabase SQL Editor after 0001.
-- ═══════════════════════════════════════════════════════════════════

alter type agent_name add value if not exists 'AssignmentEdgecaseAgent';
