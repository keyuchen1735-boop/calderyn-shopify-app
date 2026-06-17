-- refund_fact: line-level refunds ingested from the Shopify refunds/create
-- webhook, for per-SKU return-rate analytics (F5). One row per refunded line
-- item. Mirrors the order_line_fact shape + RLS pattern; the transform worker
-- writes with the service-role key (bypasses RLS), so only a read policy exists.
--
-- NOTE: base fact tables in this repo are owned by the engine repo's schema; this
-- file is the canonical mirror. The same DDL is applied to the live Supabase via
-- the app's migration tooling — keep the two in sync.
create table public.refund_fact (
  id               uuid primary key default gen_random_uuid(),
  shop_id          uuid not null references public.shops(id) on delete cascade,
  order_id         uuid references public.order_fact(id) on delete cascade,
  sku_id           uuid references public.sku_dim(id) on delete set null,
  -- Shopify Refund GID (gid://shopify/Refund/<id>).
  external_id      text not null,
  -- Refund line item id (unique per refunded line) — the idempotent upsert key.
  external_line_id text not null,
  quantity         integer not null,
  -- Refunded line subtotal (the revenue returned), cents.
  subtotal_cents   integer not null,
  processed_at     timestamptz not null,
  source_version   bigint not null,
  unique (shop_id, external_line_id)
);

-- Per-SKU windowed scan: returns over the trailing 30 days.
create index refund_fact_sku_idx on public.refund_fact (sku_id, processed_at desc);

alter table public.refund_fact enable row level security;
create policy refund_fact_read on public.refund_fact
  for select using (shop_id = public.current_shop_id());
