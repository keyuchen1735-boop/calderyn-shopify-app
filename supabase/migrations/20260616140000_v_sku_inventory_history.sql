-- v_sku_inventory_history: daily on-hand per SKU over a trailing 90-day window,
-- for the inventory page's per-SKU stock-trend sparkline (embedded app + dashboard).
--
-- inventory_level_fact is EVENT-SOURCED: a row exists only when a (sku, location)
-- level changes. So the on-hand on any day D is NOT "sum of rows dated D" — it is
-- the sum, across every location the SKU is stocked at, of that location's latest
-- observation AS OF day D (carry-forward). This is the exact same model
-- v_sku_regional_demand uses for CURRENT on-hand (its latest_inv CTE), so the
-- newest point here reconciles with v_skus_flat.on_hand.
--
-- Points are SPARSE: one row per day on which the SKU had ANY observation (bounded
-- by the 90-day window — at most ~90 rows/SKU). Surfaces connect the points with a
-- line; between observations the true series is a step (stock held steady), which a
-- straight segment approximates — fine for a trend sparkline.
--
-- Buckets use the UTC calendar day, matching the TS-side projectedStockoutDate /
-- formatStockoutDate (also UTC). security_invoker (like every other view in this
-- schema); the app queries as service-role/BYPASSRLS and scopes every read with an
-- explicit .eq('shop_id', ...) — the shop_id column below is that guard.
--
-- The existing inventory_level_current_idx (sku_id, location_id, observed_at DESC)
-- serves both the per-day carry-forward lateral and the windowed scan; no new index.
--
-- ACCESS CONTRACT: query this view PER SKU — always with .eq('shop_id', ...) AND
-- .eq('sku_id', ...). sku_locs scans the full fact table unbounded; only the
-- pushed-down sku_id predicate keeps it cheap. A bare shop-wide `select *` would
-- table-scan, so there is intentionally no all-SKUs batch consumer.
create or replace view public.v_sku_inventory_history as
with windowed as (
  select shop_id, sku_id, location_id, observed_at
  from public.inventory_level_fact
  where observed_at >= (now() - interval '90 days')
),
-- Days to plot: any UTC day the SKU had an observation inside the window.
sku_days as (
  select distinct shop_id, sku_id, (observed_at at time zone 'UTC')::date as day
  from windowed
),
-- Every location the SKU has ever been stocked at (NOT just in-window): a location
-- that last changed before the window still holds stock that must count toward the
-- daily total. The outer sku_id filter pushes down so this stays bounded per query.
sku_locs as (
  select distinct shop_id, sku_id, location_id
  from public.inventory_level_fact
)
select sd.shop_id,
       sd.sku_id,
       sd.day,
       sum(coalesce(lv.available, 0))::int as on_hand
from sku_days sd
join sku_locs sl
  on sl.shop_id = sd.shop_id and sl.sku_id = sd.sku_id
-- Per (day, location): that location's latest observation on or before the day.
-- Scans past the window so carry-forward works from before the window start.
left join lateral (
  select i.available
  from public.inventory_level_fact i
  where i.sku_id = sl.sku_id
    and i.location_id = sl.location_id
    and (i.observed_at at time zone 'UTC')::date <= sd.day
  order by i.observed_at desc, i.source_version desc
  limit 1
) lv on true
group by sd.shop_id, sd.sku_id, sd.day;

-- Match every other view in this schema (20260604140000_views_security_invoker.sql).
alter view public.v_sku_inventory_history set (security_invoker = on);
