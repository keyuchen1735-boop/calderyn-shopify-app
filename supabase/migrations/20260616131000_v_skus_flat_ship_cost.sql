-- True Ship Cost Part 2 Task 10: add ship_cost_source + ship_cost_confidence to
-- v_skus_flat. A SKU aggregates many orders, each with potentially different
-- provenance. Decision: surface the WORST (lowest-confidence) provenance among
-- the SKU's orders — the most cautious signal available. Confidence ranks:
--   low < med < high
-- so we ORDER BY that rank ASC and pick the first row's source/confidence.
-- If no order has been resolved yet, both columns are NULL.

drop view if exists public.v_skus_flat;

create or replace view public.v_skus_flat
  with (security_invoker = true)
as
with max_order_day as (
  select  shop_id,
          max(created_at_source) as anchor_ts
    from  order_fact
   group by shop_id
),
latest_inv as (
  select distinct on (i.sku_id, i.location_id)
         i.shop_id,
         i.sku_id,
         i.location_id,
         i.available,
         i.observed_at
    from inventory_level_fact i
   order by i.sku_id, i.location_id, i.observed_at desc
),
inv_by_sku as (
  select li.shop_id,
         li.sku_id,
         sum(li.available)::integer as on_hand,
         jsonb_object_agg(coalesce(l.name, l.external_id), li.available) as locations
    from latest_inv li
    left join location_dim l on l.id = li.location_id
   group by li.shop_id, li.sku_id
),
velocity_30d as (
  select ol.shop_id,
         ol.sku_id,
         sum(ol.quantity)::numeric / 30.0 as units_per_day
    from order_line_fact ol
    join order_fact o on o.id = ol.order_id
    join max_order_day m on m.shop_id = ol.shop_id
   where o.created_at_source > (m.anchor_ts - interval '30 days')
     and o.created_at_source <= m.anchor_ts
     and ol.sku_id is not null
   group by ol.shop_id, ol.sku_id
),
-- Worst-provenance per SKU: join order_line_fact → order_fact, rank confidence
-- low=1 < med=2 < high=3, take the row with the smallest rank (most cautious).
-- NULLs (unresolved orders) rank last so a single resolved order always wins
-- over no signal.
sku_worst_prov as (
  select distinct on (ol.shop_id, ol.sku_id)
         ol.shop_id,
         ol.sku_id,
         o.ship_cost_source,
         o.ship_cost_confidence
    from order_line_fact ol
    join order_fact o on o.id = ol.order_id and o.shop_id = ol.shop_id
   where ol.sku_id is not null
     and o.ship_cost_source is not null
   order by
         ol.shop_id,
         ol.sku_id,
         -- rank low=1, med=2, high=3; NULLs pushed last by where clause
         case o.ship_cost_confidence
           when 'low'  then 1
           when 'med'  then 2
           when 'high' then 3
           else 4
         end asc
)
select
  sk.id,
  sk.shop_id,
  sk.title,
  sk.sku,
  coalesce(inv.on_hand, 0)          as on_hand,
  coalesce(v.units_per_day, 0)      as velocity,
  case
    when coalesce(v.units_per_day, 0) > 0
      then round(coalesce(inv.on_hand, 0)::numeric / v.units_per_day, 1)
    when coalesce(inv.on_hand, 0) > 0 then 999
    else 0
  end                                as days_of_cover,
  coalesce(inv.locations, '{}')     as locations,
  wp.ship_cost_source,
  wp.ship_cost_confidence
from sku_dim sk
left join inv_by_sku inv       on inv.sku_id = sk.id   and inv.shop_id = sk.shop_id
left join velocity_30d v       on v.sku_id   = sk.id   and v.shop_id   = sk.shop_id
left join sku_worst_prov wp    on wp.sku_id  = sk.id   and wp.shop_id  = sk.shop_id;
