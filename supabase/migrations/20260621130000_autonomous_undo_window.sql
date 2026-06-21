-- Actor-dependent undo window: autopilot gets 48h, merchant gets 24h.
-- undo_eligible is updated to use a CASE on actor_user_id.
-- undo_expires_at is appended as a new column so existing consumers are unaffected.
--
-- Rationale: autonomous actions (actor='autopilot') fire without a per-action
-- merchant click. The merchant needs more time to notice and act, so they get 48h.
-- Merchant-initiated actions keep 24h (pre_state staleness risk is symmetric, but
-- the merchant just made the decision so 24h is the right friction).
--
-- Implementation: computed inline on the view rather than a physical column —
-- no backfill, no migration risk, existing rows inherit the correct window from
-- their recorded actor_user_id.
--
-- undo.server.ts mirrors the same logic at the API boundary (undoWindowMs()).
create or replace view public.v_audit_view
  with (security_invoker = on) as
select
  aa.id,
  aa.shop_id,
  aa.action_kind::text as action_kind,
  case
    when aa.outcome = any (array['succeeded'::action_outcome, 'failed'::action_outcome]) then aa.outcome::text
    else 'failed'::text
  end as outcome,
  coalesce(aa.params ->> 'target', aa.params ->> 'campaign_name', aa.params ->> 'sku',
           aa.params ->> 'campaign_id', aa.params ->> 'sku_id', '') as target,
  coalesce(aa.dollar_impact_at_exec, 0::numeric) as dollar_impact_at_exec,
  coalesce(aa.pre_state, 'null'::jsonb) as pre_state,
  coalesce(aa.post_state, 'null'::jsonb) as post_state,
  aa.created_at,
  coalesce(aa.actor_user_id, 'system') as actor,
  -- undo_eligible: actor-dependent window (48h for autopilot, 24h for merchant).
  aa.outcome = 'succeeded'::action_outcome
    and aa.undo_of is null
    and not (exists (select 1 from action_audit u where u.undo_of = aa.id))
    and now() < aa.created_at + case
      when coalesce(aa.actor_user_id, '') = 'autopilot' then interval '48 hours'
      else interval '24 hours'
    end as undo_eligible,
  aa.alert_id,
  coalesce(al.detector_id, '') as detector_id,
  aa.last_error as failure_reason,
  aa.undo_of,
  aa.trigger_reason,
  aa.params ->> 'sku_id' as param_sku_id,
  aa.params ->> 'platform' as param_platform,
  aa.params -> 'po' -> 'lines' -> 0 ->> 'sku' as param_po_sku,
  -- New: explicit undo expiry timestamp for UI display (appended to preserve column order).
  aa.created_at + case
    when coalesce(aa.actor_user_id, '') = 'autopilot' then interval '48 hours'
    else interval '24 hours'
  end as undo_expires_at
from action_audit aa
left join alerts al on al.id = aa.alert_id
order by aa.created_at desc;
