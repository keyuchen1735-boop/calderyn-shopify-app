-- supabase/migrations/20260419000006_rls_policies.sql

-- shops: a shop can read/update its own row; service_role bypasses RLS.
create policy shops_self_read on public.shops
  for select
  using (id = public.current_shop_id());

create policy shops_self_update on public.shops
  for update
  using (id = public.current_shop_id())
  with check (id = public.current_shop_id());

-- shop_integrations: scope by shop_id.
create policy shop_integrations_self_read on public.shop_integrations
  for select
  using (shop_id = public.current_shop_id());

create policy shop_integrations_self_write on public.shop_integrations
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());

-- raw_shopify_webhook: scope by shop_id (read-only for merchant role — writes via service_role).
create policy raw_shopify_webhook_self_read on public.raw_shopify_webhook
  for select
  using (shop_id = public.current_shop_id());
