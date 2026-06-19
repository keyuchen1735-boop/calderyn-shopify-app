-- Consume seam access to the learned action policy (spec §7) WITHOUT exposing the
-- moat / moat_keys schemas over PostgREST. A SECURITY DEFINER function in `public`
-- (always exposed) resolves the shop's pseudonym and returns the learned mu. This
-- is least-privilege: service_role gets EXECUTE on this one function, not broad
-- read on the anonymized moat schema. SET search_path = '' + fully-qualified names
-- per SECURITY DEFINER hardening. Returns NULL when no model row exists, so the TS
-- seam falls through to the full merchant cap (today's behavior) — safe cutover.
create or replace function public.autopilot_action_mu(
  p_shop_id uuid,
  p_detector_id text,
  p_action_kind text
) returns numeric
language sql
stable
security definer
set search_path = ''
as $func$
  select (m.policy_json->>'mu')::numeric
  from moat_keys.shop_pseudonym k
  join moat.action_models m
    on m.shop_id_pseudonym = k.pseudonym_id
   and m.detector_id = p_detector_id
   and m.action_kind = p_action_kind
  where k.shop_id = p_shop_id
  limit 1;
$func$;

revoke all on function public.autopilot_action_mu(uuid, text, text) from public;
grant execute on function public.autopilot_action_mu(uuid, text, text) to service_role;
