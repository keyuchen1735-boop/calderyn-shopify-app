-- Atomic tighten-only pair_dollar_cap write (spec §7: "×0.75 compounding",
-- learning may only tighten). The previous shape — read the active cap in JS,
-- min() it, deactivate, insert — was an unguarded read-modify-write: two
-- concurrent rejects could both read the old cap and the later insert could
-- LOOSEN the earlier, tighter one; a past race could also leave MULTIPLE
-- active cap rows, where min(candidate, arbitrary-row) again loosens. This fn
-- does the whole supersede in one transaction: it locks EVERY active cap row
-- for the pair, computes LEAST(candidate, all existing) in SQL (floored at 1
-- cent), deactivates them all with the superseded_by audit link, inserts the
-- single winner, and returns the cents that landed so the caller can freeze
-- the exact applied rule into action_feedback.
--
-- SECURITY DEFINER, search_path='', service_role-only (I9 pattern: revoke from
-- PUBLIC by name — revoking from anon alone leaves the PUBLIC grant).

create or replace function public.calibration_tighten_dollar_cap(
  p_shop_id uuid,
  p_detector_id text,
  p_action_kind public.action_kind,
  p_candidate_cents integer,
  p_source text
) returns integer
language plpgsql
security definer
set search_path = ''
as $func$
declare
  v_existing_min numeric;
  v_final_cents integer;
  v_new_id uuid;
begin
  v_final_cents := greatest(1, p_candidate_cents);

  -- Lock every active cap row for the pair (serializes concurrent rejects) and
  -- take the tightest existing value across all of them.
  select min((rule_value->>'cents')::numeric)
    into v_existing_min
    from (
      select rule_value
        from public.calibration_rule
       where shop_id = p_shop_id
         and detector_id = p_detector_id
         and action_kind = p_action_kind
         and rule_kind = 'pair_dollar_cap'
         and active = true
         for update
    ) locked;

  if v_existing_min is not null and v_existing_min > 0 then
    v_final_cents := greatest(1, least(v_final_cents, floor(v_existing_min)::integer));
  end if;

  insert into public.calibration_rule
    (shop_id, detector_id, action_kind, rule_kind, rule_value, source, active)
  values
    (p_shop_id, p_detector_id, p_action_kind, 'pair_dollar_cap',
     jsonb_build_object('cents', v_final_cents), p_source, true)
  returning id into v_new_id;

  update public.calibration_rule
     set active = false,
         superseded_by = v_new_id
   where shop_id = p_shop_id
     and detector_id = p_detector_id
     and action_kind = p_action_kind
     and rule_kind = 'pair_dollar_cap'
     and active = true
     and id <> v_new_id;

  return v_final_cents;
end;
$func$;

revoke all on function public.calibration_tighten_dollar_cap(uuid, text, public.action_kind, integer, text) from public;
revoke execute on function public.calibration_tighten_dollar_cap(uuid, text, public.action_kind, integer, text) from anon, authenticated;
grant execute on function public.calibration_tighten_dollar_cap(uuid, text, public.action_kind, integer, text) to service_role;
