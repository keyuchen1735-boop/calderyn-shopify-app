-- True Ship Cost Part 2: expose the per-order manual override on the features
-- view so the runner keeps reading ONE source (the view) while gaining the
-- manual-override signal. ship_cost_manual_cents is a per-order column on
-- order_fact (Task 1); add it to SELECT + GROUP BY. security_invoker preserved.
create or replace view public.v_order_ship_features
with (security_invoker = true) as
select
  o.id,
  o.shop_id,
  o.customer_country,
  o.ship_cost_manual_cents,
  case
    when count(ol.id) = 0 then null
    when bool_or(ol.grams is null) then null
    else sum(ol.grams)::int
  end as grams_sum,
  coalesce(sum(ol.quantity), 0)::int as item_count,
  (select count(*) from public.fulfillment_fact f where f.order_id = o.id)::int as fulfillment_count
from public.order_fact o
left join public.order_line_fact ol on ol.order_id = o.id
group by o.id, o.shop_id, o.customer_country, o.ship_cost_manual_cents;
