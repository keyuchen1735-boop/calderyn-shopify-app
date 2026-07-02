-- Mirror of supabase/migrations/20260702150000_action_kind_free_ship_kinds.sql
-- for the local test schema: register the two free-shipping action kinds so the
-- enum-typed action_feedback / calibration RPC writes accept them.
alter type action_kind add value if not exists 'raise_free_ship_threshold';
alter type action_kind add value if not exists 'exclude_sku_free_ship';
