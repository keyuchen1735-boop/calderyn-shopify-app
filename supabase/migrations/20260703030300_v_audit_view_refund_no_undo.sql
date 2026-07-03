-- Refunds are audited-but-NOT-undoable (platform pivot #3b). A Stripe refund is
-- irreversible — there is no "un-refund" API call — so an issue_refund audit row must
-- never advertise an undo affordance. This redefines v_audit_view (last set in
-- 20260621130000_autonomous_undo_window.sql) to exclude action_kind='issue_refund' from
-- undo_eligible; the row still appears in the audit log with its full pre/post state and
-- undo_expires_at, only the undo button is withheld. undo.server.ts enforces the same
-- refusal at the API boundary (rule 12: the UI flag is not the real guard).
--
-- Only the undo_eligible predicate changes; every other column is copied verbatim from the
-- prior definition to preserve column order + downstream consumers.
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
  -- undo_eligible: actor-dependent window (48h autopilot, 24h merchant), AND the action
  -- kind must be reversible. issue_refund is terminal (a Stripe refund cannot be undone),
  -- so it is excluded here regardless of window.
  aa.outcome = 'succeeded'::action_outcome
    and aa.action_kind <> 'issue_refund'::action_kind
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
  aa.created_at + case
    when coalesce(aa.actor_user_id, '') = 'autopilot' then interval '48 hours'
    else interval '24 hours'
  end as undo_expires_at
from action_audit aa
left join alerts al on al.id = aa.alert_id
order by aa.created_at desc;
