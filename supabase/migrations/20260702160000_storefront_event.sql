-- Live View event intake (spec 2026-07-02-analytics-live-view-design.md).
-- Server-side pageview/funnel events from the owned SSR storefront. No PII by
-- design: opaque visitor/session UUIDs + coarse Vercel geo only — no IP, no
-- user-agent, no email. Written and read via the service-role client; the RLS
-- shop-scope policy follows the Step 10 tenant-isolation convention. Realtime
-- is NOT enabled on this table — the dashboard live ping rides `orders`.

create table if not exists public.storefront_event (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references public.shops(id) on delete cascade,
  session_id   uuid not null,
  visitor_id   uuid not null,
  is_returning boolean not null default false,
  type         text not null check (type in ('page_view','cart_add','checkout_start','checkout_complete')),
  path         text not null,
  product_id   text,
  country      text,
  city         text,
  created_at   timestamptz not null default now()
);

-- The live endpoint always filters shop_id + a created_at window.
create index if not exists storefront_event_shop_time_idx
  on public.storefront_event (shop_id, created_at desc);

alter table public.storefront_event enable row level security;
drop policy if exists storefront_event_shop_scope on public.storefront_event;
create policy storefront_event_shop_scope on public.storefront_event
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.storefront_event from anon, authenticated;

-- Dashboard live "order ping": let the shop-scoped dashboard Realtime JWT see
-- this shop's orders change events (INSERT at checkout creation, UPDATE on the
-- paid flip) — same pattern as 20260609140000_dashboard_realtime.sql. The JWT
-- policy is additive (permissive OR) next to orders_shop_scope, which resolves
-- to NULL/deny for role `authenticated`. Orders rows hold no direct PII
-- (buyer PII lives in buyer_dim).
grant select on table public.orders to authenticated;
drop policy if exists dashboard_read_orders on public.orders;
create policy dashboard_read_orders on public.orders
  for select to authenticated
  using (shop_id = (auth.jwt() ->> 'shop_id')::uuid);

do $$
begin
  begin
    alter publication supabase_realtime add table public.orders;
  exception when duplicate_object then null;
  end;
end $$;
