-- Cross-instance rate limiter backing app/lib/rate-limit.server.ts.
--
-- The dashboard limiter was previously in-memory, per serverless instance — on
-- Vercel Fluid Compute (many warm instances) an attacker spread across them
-- multiplied the effective limit, so it was coarse damping, not enforcement.
-- This table + atomic touch function make the fixed-window counter shared and
-- authoritative across every instance.
--
-- App reaches this only via the service-role key (BYPASSRLS); deny-all to other
-- roles, mirroring integration_credentials / shop_settings.
create table if not exists public.rate_limit_hits (
  bucket        text        not null,
  window_start  timestamptz not null,
  count         integer     not null default 0,
  primary key (bucket, window_start)
);
alter table public.rate_limit_hits enable row level security;
revoke all on table public.rate_limit_hits from anon, authenticated;

-- Supports the opportunistic tail sweep in rate_limit_touch.
create index if not exists rate_limit_hits_window_start_idx
  on public.rate_limit_hits (window_start);

-- Atomic fixed-window increment. Derives the window from server time (one clock,
-- no client/DB skew), upserts the counter for (bucket, window), and returns the
-- new count. security definer so the app role can call it through PostgREST;
-- search_path pinned to public so it can't be hijacked. Execute is revoked from
-- anon/authenticated below — only the service role invokes it.
create or replace function public.rate_limit_touch(
  p_bucket         text,
  p_window_seconds integer
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_start timestamptz;
  v_count        integer;
begin
  if p_window_seconds is null or p_window_seconds < 1 then
    raise exception 'p_window_seconds must be >= 1';
  end if;

  v_window_start := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  insert into public.rate_limit_hits as r (bucket, window_start, count)
  values (p_bucket, v_window_start, 1)
  on conflict (bucket, window_start)
    do update set count = r.count + 1
  returning r.count into v_count;

  -- Self-clean: drop this bucket's now-expired windows (keeps an active bucket
  -- at a single row). Cheap — served by the PK prefix on (bucket, ...).
  delete from public.rate_limit_hits
   where bucket = p_bucket and window_start < v_window_start;

  -- Tail sweep: ~1% of calls purge globally-stale rows so one-shot buckets that
  -- never recur don't accumulate. Bounded and index-supported.
  if random() < 0.01 then
    delete from public.rate_limit_hits
     where window_start < now() - interval '1 day';
  end if;

  return v_count;
end;
$$;

-- Postgres grants EXECUTE to PUBLIC by default, so anon/authenticated inherit it
-- unless PUBLIC is revoked too — mirror 20260604150000_revoke_anon_rpc_execute.
revoke execute on function public.rate_limit_touch(text, integer) from public, anon, authenticated;
