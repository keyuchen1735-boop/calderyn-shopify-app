-- v_sku_remediation_inputs: per-SKU inputs for the product-economics remediation
-- engine's Phase 3 enrichment (naming the winner + detecting a dedicated mutable
-- campaign). One row per SKU that has a remediation-relevant signal.
--
-- There is NO structured SKU -> campaign key in this schema. A campaign's
-- dedication to a SKU is INFERRED: over the trailing 30-day window (same anchor
-- as v_skus_flat.velocity), join attribution_fact (order -> campaign) to
-- order_line_fact (order -> sku); a campaign is "dedicated" to a SKU when that
-- SKU's attributed revenue is >= 70% of the campaign's total attributed revenue
-- AND the campaign is active with a non-null daily_budget_cents ("mutable").
-- When the loser's spend lives in a catalog-wide campaign, no row qualifies and
-- the enrichment falls back to advisory (rule 12: never a dead button).
--
-- Columns:
--   sku_id, shop_id, sku, title
--   contribution_per_unit_cents : price - COGS - ship - returns, at ZERO ad
--     spend (the ditch-vs-tune gate's "structurally dead" basis), NULL when COGS
--     or price are unavailable (caller treats NULL as "margin source unavailable").
--   return_30d_cents            : returned revenue over the 30-day window.
--   dedicated_campaign_id       : ad_campaign_dim uuid of the dedicated mutable
--     campaign for this SKU, else NULL.
--   dedicated_campaign_platform : its platform (gateway constrains to 'meta').
--   dedicated_campaign_budget_cents : its current daily budget.
--   winner_rank                 : dense rank (1 = best) of this SKU as a catalog
--     winner: positive contribution_per_unit, stock headroom (days_of_cover >=
--     14), and a dedicated mutable campaign of its own. Higher-margin first.
--   security_invoker like every view in this schema; the app scopes reads with
--   an explicit .eq('shop_id', ...).
--
-- DEPENDENCY: references v_skus_flat (on_hand, velocity, days_of_cover,
-- ship_pnl_cents), v_sku_sales_30d (units_30d), v_sku_returns_30d
-- (returned_revenue_30d_cents), cogs_fact (unit_cost_cents), sku_dim, order_fact,
-- order_line_fact, attribution_fact, ad_campaign_dim. All exist on a current DB.

create or replace view public.v_sku_remediation_inputs
  with (security_invoker = on)
as
with max_order_day as (
  select shop_id, max(created_at_source) as anchor_ts
  from public.order_fact
  group by shop_id
),
-- Current unit cost: latest open-ended cogs_fact row per SKU.
unit_cost as (
  select distinct on (shop_id, sku_id)
         shop_id, sku_id, unit_cost_cents
  from public.cogs_fact
  where effective_to is null
  order by shop_id, sku_id, effective_from desc
),
-- Average sale price per unit over the window (gross line revenue / units).
unit_price as (
  select ol.shop_id,
         ol.sku_id,
         (sum(ol.total_cents)::numeric / nullif(sum(ol.quantity), 0)) as price_cents
  from public.order_line_fact ol
  join public.order_fact o on o.id = ol.order_id and o.shop_id = ol.shop_id
  join max_order_day m on m.shop_id = ol.shop_id
  where o.created_at_source > (m.anchor_ts - interval '30 days')
    and o.created_at_source <= m.anchor_ts
    and ol.sku_id is not null
  group by ol.shop_id, ol.sku_id
),
-- Per-unit ship cost from v_skus_flat.ship_pnl_cents is a P&L, not a cost; use
-- the 30-day returned revenue per unit sold as the returns drag instead.
returns_per_unit as (
  select r.shop_id,
         r.sku_id,
         (r.returned_revenue_30d_cents::numeric / nullif(r.units_sold_30d, 0)) as return_per_unit_cents
  from public.v_sku_returns_30d r
),
-- Each campaign's total attributed revenue + its single most-concentrated SKU
-- over the window, with that SKU's revenue share.
campaign_sku_rev as (
  select a.shop_id,
         a.campaign_id,
         ol.sku_id,
         sum(a.attributed_revenue_cents)::numeric as sku_rev
  from public.attribution_fact a
  join public.order_line_fact ol on ol.order_id = a.order_id and ol.shop_id = a.shop_id
  join public.order_fact o on o.id = a.order_id and o.shop_id = a.shop_id
  join max_order_day m on m.shop_id = a.shop_id
  where o.created_at_source > (m.anchor_ts - interval '30 days')
    and o.created_at_source <= m.anchor_ts
    and a.campaign_id is not null
    and ol.sku_id is not null
  group by a.shop_id, a.campaign_id, ol.sku_id
),
campaign_total_rev as (
  select shop_id, campaign_id, sum(sku_rev) as total_rev
  from campaign_sku_rev
  group by shop_id, campaign_id
),
-- A SKU's dedicated mutable campaign: the campaign where this SKU is >= 70% of
-- attributed revenue, the campaign is active + daily-budgeted. If a SKU is the
-- dominant SKU of more than one such campaign, take the highest-budget one.
dedicated as (
  select distinct on (csr.shop_id, csr.sku_id)
         csr.shop_id,
         csr.sku_id,
         c.id            as dedicated_campaign_id,
         c.platform      as dedicated_campaign_platform,
         c.daily_budget_cents as dedicated_campaign_budget_cents
  from campaign_sku_rev csr
  join campaign_total_rev ctr
    on ctr.shop_id = csr.shop_id and ctr.campaign_id = csr.campaign_id
  join public.ad_campaign_dim c
    on c.id = csr.campaign_id and c.shop_id = csr.shop_id
  where ctr.total_rev > 0
    and csr.sku_rev / ctr.total_rev >= 0.70
    and c.status = 'active'
    and c.daily_budget_cents is not null
  order by csr.shop_id, csr.sku_id, c.daily_budget_cents desc
),
base as (
  select sk.id   as sku_id,
         sk.shop_id,
         sk.sku,
         sk.title,
         f.days_of_cover,
         round(
           up.price_cents
           - coalesce(uc.unit_cost_cents, 0)
           - coalesce(rpu.return_per_unit_cents, 0)
         )::bigint as contribution_per_unit_cents_raw,
         (up.price_cents is not null and uc.unit_cost_cents is not null) as margin_known,
         coalesce(ret.returned_revenue_30d_cents, 0)::bigint as return_30d_cents,
         d.dedicated_campaign_id,
         d.dedicated_campaign_platform,
         d.dedicated_campaign_budget_cents
  from public.sku_dim sk
  join public.v_skus_flat f on f.id = sk.id and f.shop_id = sk.shop_id
  left join unit_price up        on up.sku_id = sk.id and up.shop_id = sk.shop_id
  left join unit_cost uc         on uc.sku_id = sk.id and uc.shop_id = sk.shop_id
  left join returns_per_unit rpu on rpu.sku_id = sk.id and rpu.shop_id = sk.shop_id
  left join public.v_sku_returns_30d ret on ret.sku_id = sk.id and ret.shop_id = sk.shop_id
  left join dedicated d          on d.sku_id = sk.id and d.shop_id = sk.shop_id
)
select
  b.sku_id,
  b.shop_id,
  b.sku,
  b.title,
  case when b.margin_known then b.contribution_per_unit_cents_raw else null end
    as contribution_per_unit_cents,
  b.return_30d_cents,
  b.dedicated_campaign_id,
  b.dedicated_campaign_platform,
  b.dedicated_campaign_budget_cents,
  -- Catalog-winner ranking: positive contribution, >=14 days of cover (stock
  -- headroom to absorb scaled spend), and its own dedicated mutable campaign.
  -- Higher contribution_per_unit ranks first. NULL for non-qualifying SKUs.
  case
    when b.margin_known
     and b.contribution_per_unit_cents_raw > 0
     and b.days_of_cover >= 14
     and b.dedicated_campaign_id is not null
    then dense_rank() over (
      partition by b.shop_id
      order by b.contribution_per_unit_cents_raw desc
    )
    else null
  end as winner_rank
from base b;

alter view public.v_sku_remediation_inputs set (security_invoker = on);
