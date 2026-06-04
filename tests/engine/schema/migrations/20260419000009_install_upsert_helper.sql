-- supabase/migrations/20260419000009_install_upsert_helper.sql
--
-- OAuth install path needs to insert/upsert into public.shops, but at that
-- moment we don't yet have a session — current_shop_id() is NULL, and the
-- shops_self_* RLS policies wouldn't permit the insert anyway.
--
-- Mirrors the lookup_shop_id_by_domain pattern from migration 008: a narrow
-- SECURITY DEFINER function that performs exactly one well-defined operation
-- and returns the resulting shop id. Called from shopify.server.ts afterAuth.

create or replace function public.upsert_shop_on_install(p_shop_domain text)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into public.shops (shop_domain, installed_at, uninstalled_at)
  values (p_shop_domain, now(), null)
  on conflict (shop_domain) do update
    set installed_at   = excluded.installed_at,
        uninstalled_at = null,
        updated_at     = now()
  returning id into v_id;
  return v_id;
end$$;

revoke all on function public.upsert_shop_on_install(text) from public;
grant execute on function public.upsert_shop_on_install(text)
  to authenticated, service_role, anon;
