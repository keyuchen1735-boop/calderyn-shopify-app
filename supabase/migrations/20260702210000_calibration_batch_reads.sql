-- Batch reads for the calibration recompute — kills the cron's N+1 shape
-- (same 504 risk class the ingest cron hit at scale) and the silent
-- 1000-row PostgREST truncation on busy shops.
--
-- 1. action_pair_priors(): every qualifying peer baseline in ONE call.
--    moat.action_baselines is a peer-aggregate table with no per-shop column,
--    so the result is shop-independent — the nightly cron fetches it once for
--    the whole run instead of one action_pair_prior RPC per pair per shop.
--    Latest row per (detector, action), k-anonymity floor n >= 5 (identical
--    semantics to action_pair_prior, which stays for compatibility).
--
-- 2. calibration_detector_stats(shop, since): per-detector alert fires and
--    detection-challenging rejects (not_enough_data/other) as exact GROUP BY
--    counts — replaces two row-listing reads that silently truncated at the
--    PostgREST row cap and skewed the headline weights on busy shops.
--
-- SECURITY DEFINER, search_path='', service_role-only (I9 pattern: revoke
-- from PUBLIC by name; moat stays off PostgREST).
--
-- DEPLOY ORDER: apply this migration to prod BEFORE deploying the code that
-- calls these fns (the recompute falls back to its legacy row-listing reads
-- when the stats fn is missing, so a skew window degrades gracefully — but
-- the fallback carries the old row-cap truncation, so do not rely on it).

create or replace function public.action_pair_priors()
returns table (detector_id text, action_kind text, p50 numeric)
language sql
stable
security definer
set search_path = ''
as $func$
  select distinct on (b.detector_id, b.action_kind)
         b.detector_id, b.action_kind, b.p50
  from moat.action_baselines b
  where b.n >= 5
  order by b.detector_id, b.action_kind, b.updated_at desc;
$func$;

revoke all on function public.action_pair_priors() from public;
revoke execute on function public.action_pair_priors() from anon, authenticated;
grant execute on function public.action_pair_priors() to service_role;

create or replace function public.calibration_detector_stats(
  p_shop_id uuid,
  p_since timestamptz
)
returns table (detector_id text, fired bigint, challenged bigint)
language sql
stable
security definer
set search_path = ''
as $func$
  select detector_id,
         coalesce(sum(fired), 0)::bigint      as fired,
         coalesce(sum(challenged), 0)::bigint as challenged
  from (
    select a.detector_id, count(*) as fired, 0 as challenged
    from public.alerts a
    where a.shop_id = p_shop_id
      and a.first_seen_at >= p_since
    group by a.detector_id
    union all
    select f.detector_id, 0 as fired, count(*) as challenged
    from public.action_feedback f
    where f.shop_id = p_shop_id
      and f.decision = 'reject'
      and f.reject_reason in ('not_enough_data', 'other')
      and f.created_at >= p_since
    group by f.detector_id
  ) stats
  group by detector_id;
$func$;

revoke all on function public.calibration_detector_stats(uuid, timestamptz) from public;
revoke execute on function public.calibration_detector_stats(uuid, timestamptz) from anon, authenticated;
grant execute on function public.calibration_detector_stats(uuid, timestamptz) to service_role;
