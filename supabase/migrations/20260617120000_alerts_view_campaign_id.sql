-- F1 hardening: expose the alert's campaign dim id + platform external id on
-- v_alerts_view so callers match alerts to campaign rows by ID, not by name
-- (two campaigns sharing a name could otherwise mis-attribute a suggestion).
--
-- The ad_campaign_dim join already exists (it feeds camp.name); we only surface
-- camp.id and camp.external_id. New columns are appended at the END of the
-- select list — CREATE OR REPLACE VIEW requires the existing columns keep their
-- name/order/type. Same body + snooze filter as 20260613160000;
-- security_invoker re-asserted to preserve the cross-tenant RLS hardening.
create or replace view public.v_alerts_view
  with (security_invoker = on) as
select
  a.id,
  a.shop_id,
  a.detector_id,
  a.severity::text as severity,
  case
    when a.status = 'snoozed'::alert_status   then 'open'::text
    when a.status = 'dismissed'::alert_status then 'resolved'::text
    else a.status::text
  end as status,
  a.dollar_impact,
  coalesce(a.claude_rank, 999) as claude_rank,
  a.first_seen_at as created_at,
  coalesce(
    a.entity_ref ->> 'title',
    camp.name,
    sku.title,
    a.entity_ref ->> 'sku',
    initcap(replace(a.detector_id, '_', ' '))
  ) as title,
  coalesce(a.claude_narrative, ''::text) as narrative,
  coalesce(a.entity_ref ->> 'campaign', camp.name) as campaign,
  coalesce(a.entity_ref ->> 'sku', sku.sku) as sku,
  coalesce(ac.evidence, '{}'::jsonb) as evidence,
  -- Appended columns (F1 hardening): resolved campaign dim id + platform
  -- external id, NULL for non-campaign alerts. Used to match alerts to rows.
  camp.id          as campaign_id,
  camp.external_id as campaign_external_id
from alerts a
  left join alert_context ac  on ac.alert_id = a.id
  left join ad_campaign_dim camp on camp.id::text = a.entity_ref ->> 'campaign_id'
  left join sku_dim sku        on sku.id::text  = a.entity_ref ->> 'sku_id'
where not (
  a.status = 'snoozed'::alert_status
  and a.snoozed_until is not null
  and a.snoozed_until > now()
);
