-- CRITICAL: close an anon cross-tenant data breach.
--
-- Every per-shop RLS policy is `shop_id = current_shop_id()`, where
-- current_shop_id() reads the `app.shop_id` GUC. The SECURITY DEFINER function
-- set_current_shop_id(uuid) sets that GUC and was EXECUTABLE BY anon via
-- PostgREST RPC — so an anonymous caller (public/anon key) could set the context
-- to ANY shop and read that shop's data, bypassing RLS entirely (verified live).
-- lookup_shop_id_by_domain leaked shop UUIDs; upsert_shop_on_install let anon
-- create/modify shop rows.
--
-- This app reaches Postgres only via the service-role key (BYPASSRLS) and never
-- calls these RPCs (it uses PostgREST table queries with explicit shop_id
-- filters), so revoking anon/authenticated EXECUTE breaks nothing here.

revoke execute on function public.set_current_shop_id(uuid)        from public, anon, authenticated;
revoke execute on function public.lookup_shop_id_by_domain(text)   from public, anon, authenticated;
revoke execute on function public.upsert_shop_on_install(text)     from public, anon, authenticated;
