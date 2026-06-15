-- Make actions reversible for their full audit lifetime, not just 24h.
--
-- v_audit_view.undo_eligible previously required `created_at > now() - 24h`.
-- But undo.server.ts permits reversing ANY succeeded, not-yet-undone action
-- regardless of age — its own comment states "undo_eligible only gates the UI;
-- the API is the real boundary." So the 24h window was a UI-only restriction
-- that hid the Undo button for actions the server would happily reverse, on
-- both the dashboard and the embedded extension (they share this view).
--
-- Drop the recency condition so the UI gate matches the server's real policy:
-- a succeeded action that is not itself an undo and has not already been undone
-- is reversible (90-day audit retention naturally bounds it). Reversal replays
-- the recorded pre_state, so undoing a long-old budget change restores that old
-- budget — inherent to undo at any age and already server-permitted.
create or replace view public.v_audit_view as
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
    aa.outcome = 'succeeded'::action_outcome
      and aa.undo_of is null
      and not (exists (select 1 from action_audit u where u.undo_of = aa.id)) as undo_eligible,
    aa.alert_id,
    coalesce(al.detector_id, '') as detector_id,
    aa.last_error as failure_reason,
    aa.undo_of,
    aa.trigger_reason,
    aa.params ->> 'sku_id' as param_sku_id,
    aa.params ->> 'platform' as param_platform,
    aa.params -> 'po' -> 'lines' -> 0 ->> 'sku' as param_po_sku
  from action_audit aa
  left join alerts al on al.id = aa.alert_id
  order by aa.created_at desc;

alter view public.v_audit_view set (security_invoker = on);
