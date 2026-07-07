-- v_sku_returns_30d: per-SKU return rate over the trailing 30 days, for the
-- inventory page's returns deep-dive (F5).
--
-- Numerator: refunded units whose ORDER falls in the window — the refund is
-- attributed to the order's date (order_fact.created_at_source within the same
-- 30-day anchor as v_skus_flat.velocity), NOT the later refund-processed date.
-- This makes the numerator the same cohort as the denominator (units SOLD in the
-- window, v_sku_sales_30d.units_30d from sibling feature F3): a return rate is
-- "returns of this window's orders ÷ that window's units sold", bounded at 100%
-- rather than letting a late refund of an out-of-window order push it past 1.0.
-- return_rate is NULL when there were no sales in the window (no divide-by-zero).
-- Refunds whose order didn't resolve (order_id null) are excluded — they can't be
-- windowed to an order date.
--
-- DEPENDENCY: this view references v_sku_sales_30d (migration
-- 20260616150001_v_sku_sales_30d.sql, feature F3). On a fresh DB, F3 must be
-- applied first. security_invoker like every view in this schema; the app scopes
-- reads with an explicit .eq('shop_id', ...).
create or replace view public.v_sku_returns_30d as
with max_order_day as (
  select shop_id, max(created_at_source) as anchor_ts
  from public.order_fact
  group by shop_id
),
returns as (
  select r.shop_id,
         r.sku_id,
         sum(r.quantity)::int        as returned_units_30d,
         sum(r.subtotal_cents)::bigint as returned_revenue_30d_cents
  from public.refund_fact r
  join public.order_fact o on o.id = r.order_id and o.shop_id = r.shop_id
  join max_order_day m on m.shop_id = r.shop_id
  where o.created_at_source > (m.anchor_ts - interval '30 days')
    and o.created_at_source <= m.anchor_ts
    and r.sku_id is not null
  group by r.shop_id, r.sku_id
)
select ret.shop_id,
       ret.sku_id,
       ret.returned_units_30d,
       ret.returned_revenue_30d_cents,
       s.units_30d as units_sold_30d,
       case
         when s.units_30d > 0
         then round(ret.returned_units_30d::numeric / s.units_30d, 4)
         else null
       end as return_rate
from returns ret
left join public.v_sku_sales_30d s
  on s.shop_id = ret.shop_id and s.sku_id = ret.sku_id;

alter view public.v_sku_returns_30d set (security_invoker = on);
