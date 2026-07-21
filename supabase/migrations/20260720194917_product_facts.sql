create unique index if not exists product_dim_shop_id_id_key on public.product_dim(shop_id, id);

create table public.product_fact (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  product_id uuid not null,
  kind text not null check (kind in (
    'dimension.width', 'dimension.depth', 'dimension.height', 'material', 'compatibility',
    'ingredient', 'concern', 'heat_level', 'document_url', 'ar_model_url'
  )),
  text_value text,
  number_value numeric,
  unit text,
  url_value text,
  position integer not null default 0 check (position between 0 and 31),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (shop_id, product_id) references public.product_dim(shop_id, id) on delete cascade,
  unique (shop_id, product_id, position),
  check (
    (kind in ('dimension.width', 'dimension.depth', 'dimension.height')
      and number_value > 0 and unit in ('mm', 'cm', 'm', 'in') and text_value is null and url_value is null)
    or (kind in ('material', 'compatibility', 'ingredient', 'concern')
      and char_length(btrim(text_value)) between 1 and 160 and number_value is null and unit is null and url_value is null)
    or (kind = 'heat_level'
      and number_value between 0 and 5 and number_value = trunc(number_value) and text_value is null and unit is null and url_value is null)
    or (kind = 'document_url'
      and url_value ~ '^https://[^[:space:]]+$' and url_value !~ '^https://[^/]*@'
      and char_length(url_value) <= 2048 and text_value is null and number_value is null and unit is null)
    or (kind = 'ar_model_url'
      and url_value ~ '^https://[^[:space:]]+$' and url_value !~ '^https://[^/]*@'
      and url_value ~* '\.(glb|gltf|usdz)([?#].*)?$'
      and char_length(url_value) <= 2048 and text_value is null and number_value is null and unit is null)
  )
);

create index product_fact_shop_product_idx on public.product_fact(shop_id, product_id, position, id);
create unique index product_fact_dimension_width_unique on public.product_fact(shop_id, product_id) where kind = 'dimension.width';
create unique index product_fact_dimension_depth_unique on public.product_fact(shop_id, product_id) where kind = 'dimension.depth';
create unique index product_fact_dimension_height_unique on public.product_fact(shop_id, product_id) where kind = 'dimension.height';
alter table public.product_fact enable row level security;
create policy product_fact_tenant_isolation on public.product_fact
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
grant select on public.product_fact to app_web;
