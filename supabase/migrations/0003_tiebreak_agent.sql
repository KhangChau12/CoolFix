-- ═══════════════════════════════════════════════════════════════════
-- CoolFix — migration 0003
-- Adds the Assignment Tie-break Agent to the agent_name enum.
-- This agent runs ONLY when the transparent scoring formula produces an
-- ambiguous result (top two candidates within 10%, a single strained
-- candidate, or an urgent job with no strong fit). It reads the top-3
-- eligible candidates and picks one, with a rationale — its pick is then
-- re-scored against live state before commit. No column change: it writes
-- a normal agent_decision_log row (score_breakdown + candidates jsonb).
-- Run this in the Supabase SQL Editor after 0002.
-- ═══════════════════════════════════════════════════════════════════

alter type agent_name add value if not exists 'AssignmentTiebreakAgent';
