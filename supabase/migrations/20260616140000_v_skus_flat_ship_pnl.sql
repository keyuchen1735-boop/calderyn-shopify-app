-- Free-ship "Ship P&L" column (Inventory, both surfaces): add per-SKU net
-- shipping P&L to v_skus_flat.
--
-- ship_pnl_cents = Σ over the SKU's order lines in the last 30 days of each
-- order's net shipping P&L — shipping collected (order_fact.shipping_cents)
-- minus the effective true ship cost — allocated to the SKU by the line's
-- quantity share of the order. Effective ship cost honors the merchant's manual
-- override (ship_cost_manual_cents) when present, else the resolved
-- ship_cost_cents. Positive = shipping pays for itself; negative = free shipping
-- is bleeding on this SKU. Only orders with a KNOWN ship cost contribute — an
-- unresolved cost is never treated as $0 (that would fake a profit and hide
-- leakage). NULL when the SKU has no in-window order with a resolved ship cost,
-- so the column renders "no data" rather than a misleading $0.
--
-- Same anchor + 30-day window as velocity_30d; allocation basis (line quantity
-- share) matches how velocity is derived. Appends ship_pnl_cents to the existing
-- column list (CREATE OR REPLACE VIEW append-only rule).

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
    join order_fact o on o.id = ol.order_id and o.shop_id = ol.shop_id
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
         case o.ship_cost_confidence
           when 'low'  then 1
           when 'med'  then 2
           when 'high' then 3
           else 4
         end asc
),
-- Net shipping P&L per SKU over the same 30-day window as velocity. Each order's
-- (shipping collected − effective ship cost) is split across its lines by
-- quantity share; summed per SKU. order_qty gives each order's total quantity so
-- a line's share is line.quantity / order_qty.
order_qty as (
  -- denominator over the SAME line population the numerator sums (sku_id not
  -- null), so per-SKU shares of an order's P&L total to 100%.
  select order_id, sum(quantity)::numeric as total_qty
    from order_line_fact
   where sku_id is not null
   group by order_id
),
ship_pnl_30d as (
  select ol.shop_id,
         ol.sku_id,
         round(sum(
           ( coalesce(o.shipping_cents, 0)
             - coalesce(o.ship_cost_manual_cents, o.ship_cost_cents) )::numeric
           * ol.quantity / nullif(oq.total_qty, 0)
         ))::bigint as ship_pnl_cents
    from order_line_fact ol
    join order_fact o     on o.id = ol.order_id and o.shop_id = ol.shop_id
    join max_order_day m  on m.shop_id = ol.shop_id
    join order_qty oq     on oq.order_id = ol.order_id
   where o.created_at_source > (m.anchor_ts - interval '30 days')
     and o.created_at_source <= m.anchor_ts
     and ol.sku_id is not null
     -- only orders whose true ship cost is KNOWN contribute; never treat an
     -- unresolved cost as $0 (would fake a profit). SKUs with no such order → NULL.
     and coalesce(o.ship_cost_manual_cents, o.ship_cost_cents) is not null
   group by ol.shop_id, ol.sku_id
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
  wp.ship_cost_confidence,
  sp.ship_pnl_cents
from sku_dim sk
left join inv_by_sku inv       on inv.sku_id = sk.id   and inv.shop_id = sk.shop_id
left join velocity_30d v       on v.sku_id   = sk.id   and v.shop_id   = sk.shop_id
left join sku_worst_prov wp    on wp.sku_id  = sk.id   and wp.shop_id  = sk.shop_id
left join ship_pnl_30d sp      on sp.sku_id  = sk.id   and sp.shop_id  = sk.shop_id;
