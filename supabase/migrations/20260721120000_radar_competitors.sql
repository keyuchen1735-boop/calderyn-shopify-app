-- Radar Phase D: competitors (spec 2026-07-20-radar-background-watcher-design.md).
--  1. radar_competitor: auto-discovered competitor stores. status 'suggested'
--     until the merchant confirms ('watching') or dismisses; unique (shop_id,
--     url) so re-discovery can never duplicate or resurrect a row. Max 5
--     'watching' per shop is enforced in the dashboard action (code), not DDL.
--  2. radar_snapshot: polite nightly page snapshots for watching competitors.
--     captured_day + unique (competitor_id, url, captured_day) makes the
--     nightly upsert idempotent (a plain date column instead of an expression
--     index because captured_at::date is not immutable). diff is null for
--     baselines and unchanged pages are never inserted at all (hash-gated in
--     code), so this table only grows when a competitor actually changes.
--  3. radar_ploy gains two kinds: competitor_counter (refresh own home hero)
--     and competitor_price (informational review move; never auto-applies).
--  4. radar_state.last_discovered_at: cursor for the weekly discovery drain.
--  5. radar_discovery_queue: shops with a published storefront (either
--     runtime), fewer than 5 watched competitors, and demo_mode off - ordered
--     by the discovery cursor nulls first (same fairness rule as
--     radar_shop_queue).
-- RLS follows the storefront-facing tenant convention via
-- public.current_shop_id(); intentionally NOT added to the frozen
-- app/lib/security/tenant-tables.ts census (same stance as radar_core).

create table if not exists public.radar_competitor (
  id                 uuid primary key default gen_random_uuid(),
  shop_id            uuid not null references public.shops(id) on delete cascade,
  url                text not null,
  name               text not null default '',
  status             text not null default 'suggested'
                     check (status in ('suggested','watching','dismissed')),
  discovery_evidence jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create unique index if not exists radar_competitor_shop_url_idx
  on public.radar_competitor (shop_id, url);
create index if not exists radar_competitor_shop_status_idx
  on public.radar_competitor (shop_id, status);

alter table public.radar_competitor enable row level security;
drop policy if exists radar_competitor_shop_scope on public.radar_competitor;
create policy radar_competitor_shop_scope on public.radar_competitor
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.radar_competitor from anon, authenticated;
grant select on table public.radar_competitor to app_web;

create table if not exists public.radar_snapshot (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references public.shops(id) on delete cascade,
  competitor_id uuid not null references public.radar_competitor(id) on delete cascade,
  url           text not null,
  captured_at   timestamptz not null default now(),
  captured_day  date not null default (now() at time zone 'utc')::date,
  content_hash  text not null,
  extracted     jsonb not null default '{}'::jsonb,
  diff          jsonb
);

create unique index if not exists radar_snapshot_daily_idx
  on public.radar_snapshot (competitor_id, url, captured_day);
create index if not exists radar_snapshot_shop_recent_idx
  on public.radar_snapshot (shop_id, captured_at desc);

alter table public.radar_snapshot enable row level security;
drop policy if exists radar_snapshot_shop_scope on public.radar_snapshot;
create policy radar_snapshot_shop_scope on public.radar_snapshot
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.radar_snapshot from anon, authenticated;
grant select on table public.radar_snapshot to app_web;

alter table public.radar_state
  add column if not exists last_discovered_at timestamptz;

-- Two new competitor kinds. The original constraint was inline on the column
-- (auto-named radar_ploy_kind_check); drop + re-add with the full list.
alter table public.radar_ploy drop constraint if exists radar_ploy_kind_check;
alter table public.radar_ploy add constraint radar_ploy_kind_check check (kind in (
  'seo_regression_patch','seo_meta_rewrite','seo_content_boost',
  'aeo_refresh','aeo_jsonld_fix','section_refresh',
  'competitor_counter','competitor_price'));

-- Weekly discovery drain queue. Only shops that (a) have a published
-- storefront on either runtime, (b) can still watch more competitors, and
-- (c) are not demo shops (external fetches and Claude spend never run for
-- demos). Cursor fairness: last_discovered_at asc nulls first.
create or replace function public.radar_discovery_queue(p_limit int default 200)
returns table (shop_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select s.id
  from public.shops s
  left join public.radar_state rs on rs.shop_id = s.id
  where coalesce(s.demo_mode, false) = false
    and (
      exists (select 1 from public.page_document pd
              where pd.shop_id = s.id and pd.page_key = 'home'
                and pd.published_json is not null)
      or exists (select 1 from public.storefront_release sr
                 where sr.shop_id = s.id and sr.published_version_id is not null)
    )
    and (select count(*) from public.radar_competitor rc
         where rc.shop_id = s.id and rc.status = 'watching') < 5
  order by rs.last_discovered_at asc nulls first, s.id
  limit p_limit;
$$;
revoke execute on function public.radar_discovery_queue(int) from public, anon, authenticated;

-- Self-tests: fail the apply if any invariant is missing.
do $$
begin
  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'radar_competitor' and rowsecurity = true) then
    raise exception 'radar_competitor is missing RLS';
  end if;
  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'radar_snapshot' and rowsecurity = true) then
    raise exception 'radar_snapshot is missing RLS';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'radar_competitor_shop_url_idx') then
    raise exception 'radar_competitor_shop_url_idx was not created';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'radar_snapshot_daily_idx') then
    raise exception 'radar_snapshot_daily_idx (idempotency index) was not created';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'radar_state' and column_name = 'last_discovered_at'
  ) then
    raise exception 'radar_state.last_discovered_at was not added';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'radar_ploy_kind_check'
      and pg_get_constraintdef(oid) like '%competitor_counter%'
      and pg_get_constraintdef(oid) like '%competitor_price%'
  ) then
    raise exception 'radar_ploy_kind_check does not include the competitor kinds';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'radar_discovery_queue'
  ) then
    raise exception 'radar_discovery_queue was not created';
  end if;
end $$;
