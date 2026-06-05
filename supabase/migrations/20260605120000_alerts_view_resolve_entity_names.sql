-- v_alerts_view: resolve a human entity title instead of the raw detector slug.
--
-- Background
-- ----------
-- The `alerts` table has no `title` column. The previous view did:
--     COALESCE(a.entity_ref ->> 'title', a.detector_id) AS title
-- but no detector writes `entity_ref.title`, so every alert headline rendered
-- the raw slug (e.g. "campaign_below_breakeven"). `campaign` was likewise
-- always null because the view read `entity_ref ->> 'campaign'` while the
-- detectors actually store `entity_ref ->> 'campaign_id'`.
--
-- Fix
-- ---
-- The detectors already store the join keys (`campaign_id` for the one campaign
-- detector, `sku_id` for the ten SKU/inventory detectors) and the human names
-- live in the dimension tables (`ad_campaign_dim.name`, `sku_dim.title`), kept
-- current by ingestion. Resolve the name at read time by joining those dims, so
-- every existing AND future row gets a real title with no engine re-run. The
-- shop-level detector (ad_tax_overload, entity_ref = {scope:"shop"}) has no
-- name to resolve and falls back to a prettified detector label — never the
-- raw slug.
--
-- Both joins are on the dims' primary key (uuid), so each matches at most one
-- row: no fan-out. Compared as text to avoid any cast error on the json value.
--
-- security_invoker is re-asserted so this does not regress the cross-tenant
-- hardening from 20260604140000_views_security_invoker.sql.

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
  coalesce(ac.evidence, '{}'::jsonb) as evidence
from alerts a
  left join alert_context ac  on ac.alert_id = a.id
  left join ad_campaign_dim camp on camp.id::text = a.entity_ref ->> 'campaign_id'
  left join sku_dim sku        on sku.id::text  = a.entity_ref ->> 'sku_id';
