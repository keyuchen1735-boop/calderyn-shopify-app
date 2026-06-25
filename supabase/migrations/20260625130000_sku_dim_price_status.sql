-- Baseline insights for low-activity stores: capture Shopify variant retail
-- price and product status so catalog/inventory/margin detectors can run with
-- zero orders. Both nullable and additive — existing rows and the 14 existing
-- detectors are unaffected. unit_cost_cents + inventory_tracked already exist
-- (migration 20260624121000_shopify_inventory_settings.sql).
alter table public.sku_dim
  add column if not exists retail_price_cents integer
    check (retail_price_cents is null or retail_price_cents >= 0),
  add column if not exists product_status text
    check (product_status is null or product_status in ('active', 'archived', 'draft'));
