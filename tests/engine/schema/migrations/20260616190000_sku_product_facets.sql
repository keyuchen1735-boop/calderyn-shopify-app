-- Product facet columns on sku_dim for inventory slicing (F2): vendor +
-- collection membership. product_type reuses the existing `category` column
-- (Shopify productType), and `tags` already exists. Mirrors the nullable-scalar /
-- text[]-default-'{}' shape of the existing facet columns. RLS unchanged (added
-- columns inherit the table's existing read policy).
alter table public.sku_dim
  add column if not exists vendor text,
  add column if not exists collections text[] not null default '{}';

create index if not exists sku_dim_vendor_idx on public.sku_dim (shop_id, vendor);
