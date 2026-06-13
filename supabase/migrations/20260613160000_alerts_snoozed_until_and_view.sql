-- Snooze = a timed deferral of an open alert.
--
-- Until now "snooze" only wrote an audit row and left the alert open (the view
-- below already collapsed status='snoozed' -> 'open', so a snoozed alert never
-- actually disappeared). This migration makes snooze a real deferral:
--
--   1. alerts.snoozed_until records when the snooze lapses. snoozeAlert() sets
--      status='snoozed' + snoozed_until = now()+1day.
--   2. v_alerts_view now EXCLUDES rows that are still snoozed (a future
--      snoozed_until), so a snoozed alert drops out of every list until it
--      re-surfaces. Once snoozed_until passes, the row reappears mapped back to
--      'open' (the +1-day cap — no write needed). The merchant's next login
--      re-surfaces the rest (resurfaceAllSnoozes flips status back to 'open').
--
-- The alert_status enum already carries 'snoozed'/'dismissed' (the prior view
-- casts to them), so no enum change is needed. Existing rows get a NULL
-- snoozed_until and are unaffected. security_invoker is re-asserted to preserve
-- the cross-tenant hardening from 20260604140000_views_security_invoker.sql.

alter table public.alerts
  add column if not exists snoozed_until timestamptz;

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
  left join sku_dim sku        on sku.id::text  = a.entity_ref ->> 'sku_id'
-- Hide alerts whose snooze has not yet lapsed; an elapsed snooze (or a snooze
-- with no deadline) stays visible and maps back to 'open' above.
where not (
  a.status = 'snoozed'::alert_status
  and a.snoozed_until is not null
  and a.snoozed_until > now()
);
