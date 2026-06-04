-- supabase/migrations/20260419000008_webhook_rls_support.sql
-- Support for pre-auth webhook routes to resolve shop_id and write/delete
-- under RLS. Webhooks arrive before any merchant session exists, so we
-- cannot set app.shop_id from session context; we resolve it via a narrow
-- SECURITY DEFINER lookup keyed on shop_domain (a Shopify-assigned,
-- non-secret identifier that Shopify signs in the HMAC'd request body).
--
-- Fixes:
--   * webhooks.shopify.*  — `select id from shops where shop_domain=?`
--     returned zero rows under RLS; insert then silently persisted nothing.
--   * webhooks.gdpr.shop-redact — `delete from shops where shop_domain=?`
--     returned zero rows under RLS; GDPR cascade never fired.
--
-- Design: the lookup function is the ONLY pre-auth bypass. The actual
-- write/delete still runs under withShopContext (app.shop_id = <resolved id>),
-- so the insert/delete is constrained by RLS to the resolved shop's rows.

create or replace function public.lookup_shop_id_by_domain(p_shop_domain text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.shops where shop_domain = p_shop_domain;
$$;

revoke all on function public.lookup_shop_id_by_domain(text) from public;
grant execute on function public.lookup_shop_id_by_domain(text)
  to authenticated, service_role, anon;

-- INSERT policy for raw_shopify_webhook: under withShopContext, allow the
-- route to persist a row for the resolved shop only.
create policy raw_shopify_webhook_self_write on public.raw_shopify_webhook
  for insert
  with check (shop_id = public.current_shop_id());

-- DELETE policy on shops: shop/redact handler, running under
-- withShopContext(resolved_shop_id), can delete its own row. FK ON DELETE
-- CASCADE on child tables handles the rest.
create policy shops_self_delete on public.shops
  for delete
  using (id = public.current_shop_id());
