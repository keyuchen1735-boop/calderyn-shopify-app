-- Product facet columns on sku_dim for inventory slicing (F2): vendor +
-- collection membership. product_type reuses the existing `category` column
-- (Shopify productType), and `tags` already exists. Idempotent (if not exists)
-- so it composes with the test-schema mirror. RLS unchanged — added columns
-- inherit sku_dim's existing read policy.
alter table public.sku_dim
  add column if not exists vendor text,
  add column if not exists collections text[] not null default '{}';

create index if not exists sku_dim_vendor_idx on public.sku_dim (shop_id, vendor);
