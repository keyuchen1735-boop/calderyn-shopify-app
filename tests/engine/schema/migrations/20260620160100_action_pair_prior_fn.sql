-- Test-DB parity for supabase/migrations/20260619140000_autopilot_action_models.sql
-- (the moat.action_baselines table) and
-- supabase/migrations/20260620160100_action_pair_prior_fn.sql
-- (the public.action_pair_prior SECURITY DEFINER function).
--
-- Mirrors the production migrations so the RLS-guard test for action_pair_prior
-- can run against the local Postgres test container.

-- moat.action_models + moat.action_baselines (peer aggregate, no per-shop col)
create table if not exists moat.action_models (
  detector_id        text not null,
  action_kind        text not null,
  shop_id_pseudonym  text not null,
  policy_json        jsonb not null,
  posterior_json     jsonb not null,
  updated_at         timestamptz not null default now(),
  primary key (detector_id, action_kind, shop_id_pseudonym)
);

create table if not exists moat.action_baselines (
  segment      text not null,
  detector_id  text not null,
  action_kind  text not null,
  p25          numeric not null,
  p50          numeric not null,
  p75          numeric not null,
  n            int not null,
  updated_at   timestamptz not null default now(),
  primary key (segment, detector_id, action_kind)
);

-- public.action_pair_prior: service_role EXECUTE only.
-- SECURITY DEFINER + empty search_path (hardening).
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
  select b.p50
  from moat.action_baselines b
  where b.detector_id = p_detector_id
    and b.action_kind = p_action_kind
    and b.n >= 5
  order by b.updated_at desc
  limit 1;
$func$;

-- Strip EXECUTE from public pseudo-role and PostgREST roles.
revoke all on function public.action_pair_prior(uuid, text, text) from public;
revoke execute on function public.action_pair_prior(uuid, text, text) from anon, authenticated;
grant execute on function public.action_pair_prior(uuid, text, text) to service_role;
