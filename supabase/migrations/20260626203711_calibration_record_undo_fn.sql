-- Atomic negative signal: a merchant undid an autopilot action. Bump the pair's
-- consecutive_undos (graduation gate 5) and reset the clean-approval streak.
-- SECURITY DEFINER, service_role-only, mirrors calibration_record_approval.
create or replace function public.calibration_record_undo(
  p_shop_id uuid,
  p_detector_id text,
  p_action_kind public.action_kind
) returns void
language sql
security definer
set search_path = ''
as $func$
  insert into public.pair_calibration (shop_id, detector_id, action_kind, consecutive_undos, consecutive_clean_approvals, updated_at)
  values (p_shop_id, p_detector_id, p_action_kind, 1, 0, now())
  on conflict (shop_id, detector_id, action_kind) do update
    set consecutive_undos = public.pair_calibration.consecutive_undos + 1,
        consecutive_clean_approvals = 0,
        updated_at = now();
$func$;

revoke all on function public.calibration_record_undo(uuid, text, public.action_kind) from public;
revoke execute on function public.calibration_record_undo(uuid, text, public.action_kind) from anon, authenticated;
grant execute on function public.calibration_record_undo(uuid, text, public.action_kind) to service_role;
