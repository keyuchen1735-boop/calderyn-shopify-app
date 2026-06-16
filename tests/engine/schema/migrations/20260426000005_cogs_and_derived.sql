-- supabase/migrations/20260426000005_cogs_and_derived.sql
-- Plan 02 Task 7: COGS + derived (velocity, P&L, stockout forecast).

create table public.cogs_fact (
  id              uuid primary key default gen_random_uuid(),
  shop_id         uuid not null references public.shops(id) on delete cascade,
  sku_id          uuid not null references public.sku_dim(id) on delete cascade,
  unit_cost_cents integer not null,
  effective_from  timestamptz not null,
  effective_to    timestamptz,
  source          text not null,                                           -- 'quickbooks' | 'csv_import' | 'shopify_cost'
  source_ref      text,                                                    -- QB account id, CSV filename, etc.
  unique (sku_id, effective_from)
);

create table public.sku_velocity (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references public.shops(id) on delete cascade,
  sku_id       uuid not null references public.sku_dim(id) on delete cascade,
  location_id  uuid references public.location_dim(id) on delete cascade,
  window_days  integer not null,                                           -- 1 | 7 | 28
  units        numeric(12,4) not null,
  computed_at  timestamptz not null default now(),
  unique (sku_id, location_id, window_days, computed_at)
);

create table public.sku_pnl (
  id                        uuid primary key default gen_random_uuid(),
  shop_id                   uuid not null references public.shops(id) on delete cascade,
  sku_id                    uuid not null references public.sku_dim(id) on delete cascade,
  day                       date not null,
  revenue_cents             integer not null,
  cogs_cents                integer not null,
  ad_spend_attrib_cents     integer not null,
  return_cents              integer not null default 0,
  ship_cost_cents           integer not null default 0,
  contribution_margin_cents integer not null,
  unique (sku_id, day)
);

create table public.stockout_forecast (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references public.shops(id) on delete cascade,
  sku_id        uuid not null references public.sku_dim(id) on delete cascade,
  location_id   uuid references public.location_dim(id) on delete cascade,
  days_of_cover numeric(7,2) not null,
  computed_at   timestamptz not null default now(),
  unique (sku_id, location_id, computed_at)
);

create index cogs_fact_sku_idx on public.cogs_fact (sku_id, effective_from desc);
create index sku_velocity_recent_idx on public.sku_velocity (sku_id, window_days, computed_at desc);
create index sku_pnl_day_idx on public.sku_pnl (shop_id, day desc);
create index stockout_recent_idx on public.stockout_forecast (sku_id, computed_at desc);

alter table public.cogs_fact enable row level security;
alter table public.sku_velocity enable row level security;
alter table public.sku_pnl enable row level security;
alter table public.stockout_forecast enable row level security;

create policy cogs_read on public.cogs_fact
  for select using (shop_id = public.current_shop_id());

create policy velocity_read on public.sku_velocity
  for select using (shop_id = public.current_shop_id());

create policy pnl_read on public.sku_pnl
  for select using (shop_id = public.current_shop_id());

create policy stockout_read on public.stockout_forecast
  for select using (shop_id = public.current_shop_id());
