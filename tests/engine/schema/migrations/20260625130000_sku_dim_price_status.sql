-- Parity mirror of supabase/migrations/20260625130000_sku_dim_price_status.sql.
-- sku_dim.retail_price_cents + product_status: baseline catalog/margin signals so
-- detectors (missing_cost, inventory_untracked, out_of_stock_live) that filter on
-- product_status = 'active' can run with zero orders. Both nullable and additive.
alter table sku_dim
  add column if not exists retail_price_cents integer
    check (retail_price_cents is null or retail_price_cents >= 0),
  add column if not exists product_status text
    check (product_status is null or product_status in ('active', 'archived', 'draft'));
