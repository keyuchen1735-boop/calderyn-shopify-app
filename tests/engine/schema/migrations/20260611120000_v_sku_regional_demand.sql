-- v_sku_regional_demand: per-SKU demand by region + transfer candidates for
-- the inventory page (embedded app + dashboard).
--
-- Demand attribution: order lines joined to DISTINCT (shop_id, order_id,
-- location_id) tuples from successful fulfillments, then to
-- location_dim.region.  Using DISTINCT means a split shipment (two success
-- rows for the same order+location) counts only once; an order genuinely
-- fulfilled from locations in two different regions still counts once per
-- location.  Rows from null-region locations are excluded, so demand_share
-- is the share of REGIONALIZED demand only.
--
-- Window: same 30-day anchor as v_skus_flat (shop's latest order_fact row),
-- so demand_units_30d is directly comparable to that view's velocity column.
-- Small divergence from the regional_shortage_risk detector (which does not
-- dedupe or filter null regions) is intentional: this view sizes real
-- transfers and must not overcount.
create or replace view public.v_sku_regional_demand as
with max_order_day as (
  select shop_id, max(created_at_source) as anchor_ts
  from public.order_fact
  group by shop_id
),
latest_inv as (
  select distinct on (i.sku_id, i.location_id)
         i.shop_id, i.sku_id, i.location_id, i.available
  from public.inventory_level_fact i
  order by i.sku_id, i.location_id, i.observed_at desc, i.source_version desc
),
regional_demand as (
  select ol.shop_id, ol.sku_id, l.region,
         sum(ol.quantity)::numeric / 30.0 as daily_demand
  from public.order_line_fact ol
  join public.order_fact o on o.id = ol.order_id and o.shop_id = ol.shop_id
  join max_order_day m on m.shop_id = ol.shop_id
  join (
    select distinct shop_id, order_id, location_id
    from public.fulfillment_fact
    where status = 'success'
  ) f on f.order_id = ol.order_id and f.shop_id = ol.shop_id
  join public.location_dim l on l.id = f.location_id
  where o.created_at_source > (m.anchor_ts - interval '30 days')
    and o.created_at_source <= m.anchor_ts
    and ol.sku_id is not null
    and l.region is not null
  group by ol.shop_id, ol.sku_id, l.region
),
top_region as (
  select distinct on (rd.shop_id, rd.sku_id)
         rd.shop_id, rd.sku_id, rd.region, rd.daily_demand
  from regional_demand rd
  order by rd.shop_id, rd.sku_id, rd.daily_demand desc, rd.region asc
),
total_demand as (
  select shop_id, sku_id, sum(daily_demand) as total_daily_demand
  from regional_demand
  group by shop_id, sku_id
),
stock_by_region as (
  select li.shop_id, li.sku_id, l.region, sum(li.available) as qty
  from latest_inv li
  join public.location_dim l on l.id = li.location_id
  group by li.shop_id, li.sku_id, l.region
)
select tr.shop_id,
       tr.sku_id,
       tr.region                                    as main_demand_region,
       round(tr.daily_demand * 30)::int             as demand_units_30d,
       tr.daily_demand,
       case when td.total_daily_demand > 0
            then tr.daily_demand / td.total_daily_demand
            else 0 end                              as demand_share,
       coalesce(sbr.qty, 0)::int                    as stock_in_region,
       dest.external_id                             as dest_location_external_id,
       dest.name                                    as dest_location_name,
       src.external_id                              as src_location_external_id,
       src.name                                     as src_location_name,
       coalesce(src.available, 0)::int              as src_available,
       d.inventory_item_id,
       loc.locations_detail
from top_region tr
join total_demand td on td.shop_id = tr.shop_id and td.sku_id = tr.sku_id
left join stock_by_region sbr
  on sbr.shop_id = tr.shop_id and sbr.sku_id = tr.sku_id
 and sbr.region is not distinct from tr.region
left join public.sku_dim d on d.id = tr.sku_id
-- Destination: deterministic active location IN the demand region (same
-- LATERAL pick as the regional_spend_starved_stock detector).
left join lateral (
  select l.external_id, l.name
  from public.location_dim l
  where l.shop_id = tr.shop_id and l.region = tr.region and l.active
  order by l.external_id
  limit 1
) dest on true
-- Source: largest available holder OUTSIDE the demand region.
-- Inactive source locations are allowed deliberately: draining an inactive
-- location is valid.  Only the DESTINATION must be active; the executor
-- (executeInventoryRelocation) enforces that constraint at mutation time.
left join lateral (
  select l.external_id, l.name, li.available
  from latest_inv li
  join public.location_dim l on l.id = li.location_id
  where li.shop_id = tr.shop_id and li.sku_id = tr.sku_id
    and l.region is distinct from tr.region
    and li.available > 0
  order by li.available desc, l.external_id
  limit 1
) src on true
-- Per-SKU location detail (GIDs + availability) for the relocate modal's
-- source select. Keyed by external_id because SKU.locations (v_skus_flat)
-- is keyed by display name, which the Shopify mutation can't use.
left join lateral (
  select jsonb_agg(
           jsonb_build_object(
             'external_id', l.external_id,
             'name', l.name,
             'region', l.region,
             'available', li.available)
           order by li.available desc, l.external_id) as locations_detail
  from latest_inv li
  join public.location_dim l on l.id = li.location_id
  where li.shop_id = tr.shop_id and li.sku_id = tr.sku_id
) loc on true;

-- Match every other view in this schema (20260604140000_views_security_invoker.sql).
alter view public.v_sku_regional_demand set (security_invoker = on);
