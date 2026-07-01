-- Every sku_dim row must have a matching variant_dim row with the SAME id.
-- Returns the count of mismatches; must be 0.
select
  (select count(*) from public.sku_dim) as sku_rows,
  (select count(*) from public.variant_dim) as variant_rows,
  (select count(*) from public.sku_dim s
     left join public.variant_dim v on v.id = s.id
     where v.id is null) as orphan_sku_rows,
  -- products are keyed by (shop_id, product_id): seed/demo shops can share a
  -- synthetic product GID, so count distinct PAIRS, not distinct product_id alone.
  (select count(*) from (select distinct shop_id, product_id from public.sku_dim) t) as distinct_shop_products,
  (select count(*) from public.product_dim) as product_rows;
