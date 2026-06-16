-- wire ship_cost into the contribution_margin column of v_campaigns_flat.
--
-- Current formula (ratio, not cents):
--   contribution_margin = (revenue_7d_cents - spend_7d_cents) / revenue_7d_cents
--
-- New formula:
--   contribution_margin = (revenue_7d_cents - spend_7d_cents - ship_cost_7d_cents) / revenue_7d_cents
--
-- ship_cost_7d_cents is the sum of order_fact.ship_cost_cents for orders that
-- were attributed to each campaign (via attribution_fact.campaign_id) and whose
-- order date falls in the same 7-day trailing window.  COALESCE to 0 when no
-- ship-cost data is available yet (column may be NULL while the resolver
-- back-fills historical orders).
--
-- Everything else in the view is preserved verbatim.
-- security_invoker = on is preserved (set by 20260604140000_views_security_invoker.sql).

create or replace view public.v_campaigns_flat
  with (security_invoker = true)
as
with max_day as (
  select
    shop_id,
    max(day) as anchor_day
  from ad_spend_fact
  group by shop_id
),
window_7d as (
  select
    s.campaign_id,
    s.shop_id,
    sum(s.spend_cents)          as spend_7d_cents,
    sum(s.revenue_attrib_cents) as revenue_7d_cents,
    sum(s.conversions)          as conv_7d
  from ad_spend_fact s
  join max_day m on m.shop_id = s.shop_id
  where s.day >  (m.anchor_day - 7)
    and s.day <= m.anchor_day
  group by s.campaign_id, s.shop_id
),
ship_7d as (
  -- Sum ship cost from orders attributed to each campaign within the same
  -- trailing-7-day window.  The attribution window matches window_7d exactly:
  -- orders created after (anchor_day - 7) and on or before anchor_day.
  select
    a.campaign_id,
    a.shop_id,
    sum(coalesce(o.ship_cost_cents, 0)) as ship_cost_7d_cents
  from attribution_fact a
  join order_fact       o on o.id      = a.order_id
                          and o.shop_id = a.shop_id
  join max_day          m on m.shop_id  = a.shop_id
  where date(o.created_at_source) >  (m.anchor_day - 7)
    and date(o.created_at_source) <= m.anchor_day
    and a.campaign_id is not null
  group by a.campaign_id, a.shop_id
)
select
  c.id,
  c.shop_id,
  c.name,
  c.platform,
  c.status,
  c.daily_budget_cents,
  coalesce(w.spend_7d_cents,    0) as spend_7d_cents,
  coalesce(w.revenue_7d_cents,  0) as revenue_7d_cents,
  coalesce(w.conv_7d,           0) as conversions_7d,
  case
    when coalesce(w.spend_7d_cents, 0) > 0
      then round(w.revenue_7d_cents::numeric / w.spend_7d_cents::numeric, 4)
    else 0::numeric
  end as roas_7d,
  case
    when coalesce(w.revenue_7d_cents, 0) > 0
      then round(
        (w.revenue_7d_cents - w.spend_7d_cents - coalesce(s.ship_cost_7d_cents, 0))::numeric
        / w.revenue_7d_cents::numeric,
        4
      )
    else 0::numeric
  end as contribution_margin
from ad_campaign_dim c
left join window_7d  w on w.campaign_id = c.id and w.shop_id = c.shop_id
left join ship_7d    s on s.campaign_id = c.id and s.shop_id = c.shop_id;
