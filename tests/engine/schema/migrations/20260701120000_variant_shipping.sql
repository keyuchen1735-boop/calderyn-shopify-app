-- variant_shipping: per-variant shipping data (weight, dimensions, restrictions,
-- handling). Extends the owned catalog (variant_dim) without bloating it.
-- RLS pattern from 20260629130000_commerce_quote_core.sql: enable RLS,
-- shop-scope policy via current_shop_id(), revoke from anon/authenticated.
create table if not exists public.variant_shipping (
  variant_id          uuid        primary key references public.variant_dim(id) on delete cascade,
  shop_id             uuid        not null references public.shops(id) on delete cascade,
  weight_grams        int         not null default 0 check (weight_grams >= 0),
  length_mm           int         check (length_mm is null or length_mm > 0),
  width_mm            int         check (width_mm is null or width_mm > 0),
  height_mm           int         check (height_mm is null or height_mm > 0),
  requires_shipping   boolean     not null default true,
  restricted_countries text[]     not null default '{}',
  handling_days       int         not null default 0 check (handling_days >= 0),
  signature_required  boolean     not null default false,
  updated_at          timestamptz not null default now()
);
create index if not exists variant_shipping_shop_idx on public.variant_shipping(shop_id);
alter table public.variant_shipping enable row level security;
create policy variant_shipping_shop_scope on public.variant_shipping
  for all
  using  (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.variant_shipping from anon, authenticated;

-- Backfill a row per variant from the weight + requires_shipping already on variant_dim.
insert into public.variant_shipping (variant_id, shop_id, weight_grams, requires_shipping)
select v.id, v.shop_id, coalesce(v.grams, 0), coalesce(v.requires_shipping, true)
from public.variant_dim v
on conflict (variant_id) do nothing;

-- Location ship-from address (city/region/country already exist; add the rest).
alter table public.location_dim add column if not exists street1 text;
alter table public.location_dim add column if not exists street2 text;
alter table public.location_dim add column if not exists postal_code text;
