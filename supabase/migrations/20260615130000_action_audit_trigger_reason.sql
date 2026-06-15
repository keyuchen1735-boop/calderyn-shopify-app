-- action_audit.trigger_reason: a plain-language note the autopilot writes at the
-- decision point explaining why it acted. Null on manual rows (the "why" is
-- derived from the alert). No backfill — there are no autopilot rows yet.
alter table public.action_audit add column if not exists trigger_reason text;

-- Recreate v_audit_view to expose trigger_reason and two scalar params lookups
-- (sku_id, platform) that audit.list uses to resolve cost-data lineage without
-- exposing the full params blob to the client.
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
      and aa.created_at > (now() - '24:00:00'::interval)
      and not (exists (select 1 from action_audit u where u.undo_of = aa.id)) as undo_eligible,
    aa.alert_id,
    coalesce(al.detector_id, '') as detector_id,
    aa.last_error as failure_reason,
    aa.undo_of,
    aa.trigger_reason,
    aa.params ->> 'sku_id' as param_sku_id,
    aa.params ->> 'platform' as param_platform
  from action_audit aa
  left join alerts al on al.id = aa.alert_id
  order by aa.created_at desc;

alter view public.v_audit_view set (security_invoker = on);
