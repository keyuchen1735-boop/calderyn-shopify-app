-- v_sku_affinity: market-basket "frequently bought with" per SKU, for the
-- inventory page's bundles panel (F4).
--
-- For each SKU, the top co-purchased SKUs within the same order over a trailing
-- 90-day window. share = co_count ÷ (orders containing this SKU) — i.e. of the
-- orders that included SKU X, what fraction also included co-SKU Y (a directional
-- confidence, so X→Y and Y→X can differ even though co_count is symmetric).
--
-- Bounded by construction: max 6 rows per SKU (row_number cap), 90-day window,
-- and the source self-join is tiny (orders here hold ≤3 line items). The existing
-- order_line_fact unique(order_id, external_line_id) index supports the order_id
-- self-join, so no new index is needed.
--
-- security_invoker like every view in this schema; the app scopes reads with an
-- explicit .eq('shop_id', ...). Self-pairs are excluded (b.sku_id <> a.sku_id).
create or replace view public.v_sku_affinity as
with max_order_day as (
  select shop_id, max(created_at_source) as anchor_ts
  from public.order_fact
  group by shop_id
),
-- Distinct (order, sku) within the window — collapses multi-line same-SKU rows
-- so a SKU bought twice in one order isn't counted as co-purchased with itself.
order_skus as (
  select distinct ol.shop_id, ol.order_id, ol.sku_id
  from public.order_line_fact ol
  join public.order_fact o on o.id = ol.order_id and o.shop_id = ol.shop_id
  join max_order_day m on m.shop_id = ol.shop_id
  where o.created_at_source > (m.anchor_ts - interval '90 days')
    and o.created_at_source <= m.anchor_ts
    and ol.sku_id is not null
),
sku_orders as (
  select shop_id, sku_id, count(distinct order_id) as order_count
  from order_skus
  group by shop_id, sku_id
),
pairs as (
  select a.shop_id, a.sku_id, b.sku_id as co_sku_id, count(*) as co_count
  from order_skus a
  join order_skus b
    on b.shop_id = a.shop_id and b.order_id = a.order_id and b.sku_id <> a.sku_id
  group by a.shop_id, a.sku_id, b.sku_id
),
ranked as (
  select p.shop_id,
         p.sku_id,
         p.co_sku_id,
         p.co_count,
         round(p.co_count::numeric / so.order_count, 4) as share,
         row_number() over (
           partition by p.shop_id, p.sku_id
           order by p.co_count desc, p.co_sku_id
         ) as rn
  from pairs p
  join sku_orders so on so.shop_id = p.shop_id and so.sku_id = p.sku_id
)
select r.shop_id,
       r.sku_id,
       r.co_sku_id,
       d.title as co_title,
       d.sku   as co_sku,
       r.co_count,
       r.share
from ranked r
-- left join (like v_sku_regional_demand): a co-SKU always has a sku_dim row here
-- (sku_id is an FK and null rows are filtered out), so this can't drop a ranked
-- pair — kept a left join only for consistency/robustness with the sibling view.
left join public.sku_dim d on d.id = r.co_sku_id
where r.rn <= 6;

alter view public.v_sku_affinity set (security_invoker = on);
