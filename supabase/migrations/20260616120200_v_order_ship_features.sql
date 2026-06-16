-- Per-order features for ship-cost allocation. grams_sum is NULL when any line
-- lacks weight, so the allocator falls back to item count. security_invoker per
-- repo convention (20260604140000_views_security_invoker.sql).
create or replace view public.v_order_ship_features
with (security_invoker = true) as
select
  o.id,
  o.shop_id,
  o.customer_country,
  case
    when count(ol.id) = 0 then null
    when bool_or(ol.grams is null) then null
    else sum(ol.grams)::int
  end as grams_sum,
  coalesce(sum(ol.quantity), 0)::int as item_count,
  (select count(*) from public.fulfillment_fact f where f.order_id = o.id)::int as fulfillment_count
from public.order_fact o
left join public.order_line_fact ol on ol.order_id = o.id
group by o.id, o.shop_id, o.customer_country;
