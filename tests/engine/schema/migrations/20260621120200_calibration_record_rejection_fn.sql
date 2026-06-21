-- Atomic negative learning signal: a merchant rejected this (detector, action).
-- Upserts the pair's Beta beta + resets consecutive clean approvals. SECURITY
-- DEFINER so the server (service_role) can write regardless of the request RLS
-- context; shop_id is supplied by the trusted server caller. service_role-only.
create or replace function public.calibration_record_rejection(
  p_shop_id      uuid,
  p_detector_id  text,
  p_action_kind  public.action_kind,
  p_beta_delta   numeric,
  p_grad_delta   int,
  p_mute         boolean
) returns void
language sql
security definer
set search_path = ''
as $func$
  insert into public.pair_calibration (shop_id, detector_id, action_kind, beta, graduation_threshold, merchant_disabled, consecutive_clean_approvals, updated_at)
  values (p_shop_id, p_detector_id, p_action_kind, p_beta_delta, least(99, 75 + p_grad_delta), p_mute, 0, now())
  on conflict (shop_id, detector_id, action_kind) do update
    set beta                        = public.pair_calibration.beta + p_beta_delta,
        graduation_threshold        = least(99, public.pair_calibration.graduation_threshold + p_grad_delta),
        merchant_disabled           = (public.pair_calibration.merchant_disabled or p_mute),
        consecutive_clean_approvals = 0,
        updated_at                  = now();
$func$;

-- Revoke from PUBLIC pseudo-role and explicit Supabase PostgREST roles.
-- Supabase auto-grants EXECUTE to anon/authenticated on new functions even when
-- `revoke all from public` is issued; explicit revokes are required.
revoke all on function public.calibration_record_rejection(uuid, text, public.action_kind, numeric, int, boolean) from public;
revoke execute on function public.calibration_record_rejection(uuid, text, public.action_kind, numeric, int, boolean) from anon, authenticated;
grant execute on function public.calibration_record_rejection(uuid, text, public.action_kind, numeric, int, boolean) to service_role;
