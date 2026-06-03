-- Daily-grain views for client-side 30/90 windowing.
-- NOTE (Task 0 reconciliation): v_campaigns_flat is redefined to read real 7d
-- aggregates. Confirm its current output columns before applying and preserve
-- every column the app reads (id, shop_id, name, platform, status,
-- daily_budget_cents, spend_7d_cents, roas_7d, contribution_margin).
create or replace view public.v_campaign_insights_daily as
select
  f.shop_id,
  f.campaign_external_id,
  d.name as campaign_name,
  f.day_bucket,
  f.spend_cents,
  f.impressions,
  f.link_clicks,
  f.purchases,
  f.purchase_value_cents
from public.ad_spend_fact f
left join public.ad_campaign_dim d
  on d.shop_id = f.shop_id and d.external_id = f.campaign_external_id;

create or replace view public.v_ad_insights_daily as
select
  i.shop_id,
  i.ad_external_id,
  i.campaign_external_id,
  a.name as ad_name,
  i.day_bucket,
  i.spend_cents,
  i.impressions,
  i.link_clicks,
  i.purchases,
  i.purchase_value_cents,
  i.reactions,
  i.comments,
  i.shares,
  i.saves,
  i.post_engagement
from public.ad_insight_fact i
left join public.ad_dim a
  on a.shop_id = i.shop_id and a.external_id = i.ad_external_id;

-- Real trailing-7d rollup for the campaigns page + dashboard tile.
create or replace view public.v_campaigns_flat as
select
  d.external_id as id,
  d.shop_id,
  d.name,
  'Meta'::text as platform,
  coalesce(d.status, 'active') as status,
  coalesce(d.daily_budget_cents, 0) as daily_budget_cents,
  coalesce(s.spend_7d_cents, 0) as spend_7d_cents,
  coalesce(s.roas_7d, 0) as roas_7d,
  0::numeric as contribution_margin
from public.ad_campaign_dim d
left join (
  select
    shop_id,
    campaign_external_id,
    sum(spend_cents) as spend_7d_cents,
    case when sum(spend_cents) > 0
      then sum(purchase_value_cents)::numeric / sum(spend_cents)
      else 0 end as roas_7d
  from public.ad_spend_fact
  where day_bucket >= (current_date - interval '7 days')
  group by shop_id, campaign_external_id
) s on s.shop_id = d.shop_id and s.campaign_external_id = d.external_id;
