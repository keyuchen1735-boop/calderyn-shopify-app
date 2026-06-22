-- Test-schema mirror of the production sku_dim.do_not_reorder column (Phase 2).
alter table public.sku_dim
  add column if not exists do_not_reorder boolean not null default false;

create index if not exists sku_dim_do_not_reorder_idx
  on public.sku_dim (shop_id) where do_not_reorder = true;
