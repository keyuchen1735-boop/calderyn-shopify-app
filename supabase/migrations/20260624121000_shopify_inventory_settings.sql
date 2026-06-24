-- Shopify variant inventory semantics required by the sold-out-ad Autopilot
-- allowlist. NULL policy means "not synced yet" and remains fail-safe.
alter table public.sku_dim
  add column if not exists inventory_policy text
    check (inventory_policy is null or inventory_policy in ('deny', 'continue')),
  add column if not exists inventory_tracked boolean;

-- Stockout alerts are SKU-scoped. Only surface one to Autopilot when attribution
-- identifies a dedicated mutable campaign for that SKU; shared/catalog campaigns
-- remain manual because pausing the whole campaign would affect other products.
create or replace view public.v_autopilot_candidates
with (security_invoker = true) as
select
  a.id            as alert_id,
  a.shop_id       as shop_id,
  a.detector_id   as detector_id,
  a.dollar_impact as dollar_impact,
  c.id            as campaign_id,
  coalesce(c.daily_budget_cents, 0) as daily_budget_cents,
  coalesce((
    select sum(s.spend_cents) from public.ad_spend_fact s
    where s.campaign_id = c.id and s.day >= (current_date - 7)
  ), 0) as campaign_spend_cents,
  coalesce(ac.evidence, '{}'::jsonb) as evidence,
  coalesce(a.entity_ref ->> 'sku', sku.sku) as sku,
  a.entity_ref ->> 'sku_id' as sku_id
from public.alerts a
  left join public.v_sku_remediation_inputs rem
    on rem.shop_id = a.shop_id
   and rem.sku_id::text = a.entity_ref ->> 'sku_id'
  left join public.ad_campaign_dim c
    on c.id = coalesce(
      nullif(a.entity_ref ->> 'campaign_id', '')::uuid,
      case when a.detector_id = 'sku_stockout_vs_spend'
        then rem.dedicated_campaign_id else null end
    )
  left join public.alert_context ac on ac.alert_id = a.id
  left join public.sku_dim sku on sku.id::text = a.entity_ref ->> 'sku_id'
where a.status = 'open'
  and a.detector_id in (
    'campaign_below_breakeven',
    'negative_unit_economics',
    'ad_tax_overload',
    'campaign_scaling_opportunity',
    'sku_stockout_vs_spend'
  )
  and (
    a.detector_id <> 'sku_stockout_vs_spend'
    or rem.dedicated_campaign_id is not null
  );
