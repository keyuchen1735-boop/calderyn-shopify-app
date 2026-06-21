-- Anonymized peer prior for a (detector, action) pair.
--
-- Returns the p50 (median) success rate across all peers for the given
-- (detector_id, action_kind), subject to a k-anonymity floor of n >= 5.
-- Returns NULL when no qualifying baseline row exists, so the caller falls
-- back to the static seed prior.
--
-- Unlike autopilot_action_mu (which resolves a per-shop learned policy),
-- moat.action_baselines is an aggregate/peer table with NO per-shop column;
-- it is keyed on (segment, detector_id, action_kind). The p_shop_id parameter
-- is accepted for API symmetry but is NOT used in the join - there is no
-- shop-level row to resolve. The moat_keys.shop_pseudonym join used by
-- autopilot_action_mu does not apply here.
--
-- Verified columns (2026-06-20):
--   moat.action_baselines: segment, detector_id, action_kind, p25, p50, p75, n, updated_at
--   moat_keys.shop_pseudonym: shop_id, pseudonym_id, pepper_version, created_at
--
-- SECURITY: service_role EXECUTE only; moat schema stays off PostgREST.
-- SET search_path = '' + fully-qualified names per SECURITY DEFINER hardening.
create or replace function public.action_pair_prior(
  p_shop_id     uuid,
  p_detector_id text,
  p_action_kind text
) returns numeric
language sql
stable
security definer
set search_path = ''
as $func$
  -- moat.action_baselines is a peer-aggregate table (no per-shop column).
  -- p_shop_id is unused here; kept for API symmetry with autopilot_action_mu.
  select b.p50
  from moat.action_baselines b
  where b.detector_id = p_detector_id
    and b.action_kind = p_action_kind
    and b.n >= 5
  order by b.updated_at desc
  limit 1;
$func$;

-- Revoke from PUBLIC pseudo-role and explicit Supabase PostgREST roles.
-- Supabase auto-grants EXECUTE to anon/authenticated on new functions even when
-- `revoke all from public` is issued; explicit revokes are required.
revoke all on function public.action_pair_prior(uuid, text, text) from public;
revoke execute on function public.action_pair_prior(uuid, text, text) from anon, authenticated;
grant execute on function public.action_pair_prior(uuid, text, text) to service_role;
