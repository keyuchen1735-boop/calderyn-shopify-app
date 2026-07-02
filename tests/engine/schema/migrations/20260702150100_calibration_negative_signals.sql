-- Calibration negative learning signals (spec §7, the missing half of the loop).
--
-- Before this migration the Beta posterior only ever moved DOWN via queue
-- rejects: an undone action bumped consecutive_undos but wrote no beta, an
-- undone merchant approval kept both its +1 alpha and its clean_approval, and a
-- platform failure (outcome='failed') wrote nothing. Trust could only rise once
-- a pair ran autonomously — the opposite of how the learning loop is specified.
--
-- 1. calibration_record_undo now also learns:
--      autonomous undo         → beta +1.5, consecutive_undos +1
--      merchant-approved undo  → beta +1.0, clean_approvals -1 (floor 0)
--    Both reset the consecutive-clean streak; alpha history is kept (spec §3).
--    The old 3-arg signature is DROPPED first — keeping it alongside a
--    defaulted 4-arg version would make named-arg PostgREST calls ambiguous.
--    p_autonomous defaults true = the old behavior, so an in-flight deploy
--    calling with 3 args keeps working during the rollout window.
-- 2. calibration_record_failure: outcome='failed' is a +1 beta signal — the
--    pair proposed an action the platform could not land.
--
-- Both SECURITY DEFINER, search_path='', service_role-only (I9 pattern:
-- revoke from PUBLIC by name — revoking from anon alone leaves the PUBLIC grant).

drop function if exists public.calibration_record_undo(uuid, text, public.action_kind);

create function public.calibration_record_undo(
  p_shop_id uuid,
  p_detector_id text,
  p_action_kind public.action_kind,
  p_autonomous boolean default true
) returns void
language sql
security definer
set search_path = ''
as $func$
  insert into public.pair_calibration (
    shop_id, detector_id, action_kind, beta, consecutive_undos, consecutive_clean_approvals, updated_at
  )
  values (
    p_shop_id, p_detector_id, p_action_kind,
    case when p_autonomous then 1.5 else 1.0 end,
    case when p_autonomous then 1 else 0 end,
    0,
    now()
  )
  on conflict (shop_id, detector_id, action_kind) do update
    set beta = public.pair_calibration.beta + case when p_autonomous then 1.5 else 1.0 end,
        consecutive_undos = public.pair_calibration.consecutive_undos
          + case when p_autonomous then 1 else 0 end,
        clean_approvals = greatest(
          0,
          public.pair_calibration.clean_approvals - case when p_autonomous then 0 else 1 end
        ),
        consecutive_clean_approvals = 0,
        updated_at = now();
$func$;

revoke all on function public.calibration_record_undo(uuid, text, public.action_kind, boolean) from public;
revoke execute on function public.calibration_record_undo(uuid, text, public.action_kind, boolean) from anon, authenticated;
grant execute on function public.calibration_record_undo(uuid, text, public.action_kind, boolean) to service_role;

create or replace function public.calibration_record_failure(
  p_shop_id uuid,
  p_detector_id text,
  p_action_kind public.action_kind
) returns void
language sql
security definer
set search_path = ''
as $func$
  insert into public.pair_calibration (shop_id, detector_id, action_kind, beta, updated_at)
  values (p_shop_id, p_detector_id, p_action_kind, 1, now())
  on conflict (shop_id, detector_id, action_kind) do update
    set beta = public.pair_calibration.beta + 1,
        updated_at = now();
$func$;

revoke all on function public.calibration_record_failure(uuid, text, public.action_kind) from public;
revoke execute on function public.calibration_record_failure(uuid, text, public.action_kind) from anon, authenticated;
grant execute on function public.calibration_record_failure(uuid, text, public.action_kind) to service_role;
