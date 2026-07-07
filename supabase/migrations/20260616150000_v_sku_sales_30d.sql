-- v_sku_sales_30d: trailing-30-day units sold + gross revenue per SKU, for the
-- inventory page's bestseller ranking (sort by revenue / units).
--
-- Window MUST match v_skus_flat.velocity exactly so the numbers are comparable:
-- same 30-day anchor (each shop's max(order_fact.created_at_source)), same join,
-- same `sku_id is not null` filter, and NO financial_status filter. By
-- construction units_30d == round(velocity * 30), so sorting by velocity and by
-- units_30d yield the same order. Revenue is the gross line total (total_cents,
-- == price_cents * quantity in the data); cents, to match the app's convention.
--
-- security_invoker (like every view in this schema); the app queries as
-- service-role/BYPASSRLS and scopes reads with an explicit .eq('shop_id', ...).
create or replace view public.v_sku_sales_30d as
with max_order_day as (
  select shop_id, max(created_at_source) as anchor_ts
  from public.order_fact
  group by shop_id
)
select ol.shop_id,
       ol.sku_id,
       sum(ol.quantity)::int          as units_30d,
       sum(ol.total_cents)::bigint     as revenue_30d_cents
from public.order_line_fact ol
join public.order_fact o on o.id = ol.order_id and o.shop_id = ol.shop_id
join max_order_day m on m.shop_id = ol.shop_id
where o.created_at_source > (m.anchor_ts - interval '30 days')
  and o.created_at_source <= m.anchor_ts
  and ol.sku_id is not null
group by ol.shop_id, ol.sku_id;

alter view public.v_sku_sales_30d set (security_invoker = on);
