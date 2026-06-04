-- supabase/migrations/20260419000005_create_app_shop_id_helper.sql
-- Session-scoped setter for the app-level shop_id used by RLS policies.
-- Callers (the Remix app) execute: select public.set_current_shop_id(<uuid>)
-- once per connection, immediately after establishing it.

create or replace function public.set_current_shop_id(sid uuid)
returns void
language sql
security definer
set search_path = public
as $$
  select set_config('app.shop_id', sid::text, false);
$$;

create or replace function public.current_shop_id()
returns uuid
language sql
stable
set search_path = public
as $$
  select nullif(current_setting('app.shop_id', true), '')::uuid;
$$;

revoke all on function public.set_current_shop_id(uuid) from public;
grant execute on function public.set_current_shop_id(uuid) to authenticated, service_role, anon;

grant execute on function public.current_shop_id() to authenticated, service_role, anon;
