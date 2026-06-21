-- Atomic positive learning signal: a merchant approved this (detector, action).
-- Upsert the pair's Beta alpha + clean-approval counters. SECURITY DEFINER so the
-- server (service_role) can write regardless of the request RLS context; shop_id
-- is supplied by the trusted server caller. service_role-only.
create or replace function public.calibration_record_approval(
  p_shop_id uuid,
  p_detector_id text,
  p_action_kind public.action_kind
) returns void
language sql
security definer
set search_path = ''
as $func$
  insert into public.pair_calibration (shop_id, detector_id, action_kind, alpha, clean_approvals, consecutive_clean_approvals, updated_at)
  values (p_shop_id, p_detector_id, p_action_kind, 1, 1, 1, now())
  on conflict (shop_id, detector_id, action_kind) do update
    set alpha = public.pair_calibration.alpha + 1,
        clean_approvals = public.pair_calibration.clean_approvals + 1,
        consecutive_clean_approvals = public.pair_calibration.consecutive_clean_approvals + 1,
        consecutive_undos = 0,
        updated_at = now();
$func$;

-- Revoke from PUBLIC pseudo-role and explicit Supabase PostgREST roles.
-- Supabase auto-grants EXECUTE to anon/authenticated on new functions even when
-- `revoke all from public` is issued; explicit revokes are required.
revoke all on function public.calibration_record_approval(uuid, text, public.action_kind) from public;
revoke execute on function public.calibration_record_approval(uuid, text, public.action_kind) from anon, authenticated;
grant execute on function public.calibration_record_approval(uuid, text, public.action_kind) to service_role;
