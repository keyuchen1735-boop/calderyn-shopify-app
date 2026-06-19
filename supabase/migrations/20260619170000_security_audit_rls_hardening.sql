-- Security audit (2026-06-19): close anon-reachable RLS-bypass surfaces found via
-- the Supabase advisor + a whole-codebase audit.
--
-- 1) v_creative_screen_runs was created (2026-06-07/08) AFTER the 2026-06-04
--    views_security_invoker audit and missed that fix: as a SECURITY DEFINER view
--    with anon SELECT, it exposed every shop's creative-screener data (shop_id,
--    scorecards, creative inputs, variants) to anonymous PostgREST callers. Its
--    base table (public.creative_screen_run) is in `public`, which the app's
--    service-role can read directly, so security_invoker is safe here.
alter view public.v_creative_screen_runs set (security_invoker = on);
revoke all on table public.v_creative_screen_runs from anon, authenticated;

-- 2) v_peer_metric_baselines is intentionally SECURITY DEFINER (it reads the
--    `moat` schema, which service_role cannot read directly), so keep it definer
--    but remove the unintended anon/authenticated SELECT exposure.
revoke all on table public.v_peer_metric_baselines from anon, authenticated;

-- 3) autopilot_action_mu is a SECURITY DEFINER fn that resolves a shop's model
--    coefficient for an arbitrary p_shop_id; it must not be callable by the
--    anon/authenticated PostgREST roles (service_role retains EXECUTE for the app).
revoke execute on function public.autopilot_action_mu(uuid, text, text) from anon, authenticated;
