-- supabase/migrations/20260710110000_orders_list_fn_revoke.sql
-- list_orders_unified takes a caller-supplied shop id and reads orders + buyer
-- emails; the implicit PUBLIC execute grant must go (the default-privileges
-- hardening only covers anon/authenticated). Same rule as every prior RPC.
revoke all on function public.list_orders_unified(uuid, text, text[], text, text, timestamptz, timestamptz, text, boolean, text, text, int, int) from public, anon, authenticated;
