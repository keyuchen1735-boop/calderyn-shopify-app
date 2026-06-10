-- supabase/migrations/20260609120000_action_kind_push_creative.sql
-- Increment A (ad-creative screener): audit a "push variant to Meta as a paused
-- ad" action through the existing action_audit / action_idempotency tables.
alter type action_kind add value if not exists 'push_creative';
