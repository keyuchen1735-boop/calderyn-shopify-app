-- Radar Phase C core (spec 2026-07-20-radar-background-watcher-design.md).
--  1. radar_traffic_daily: per-shop daily rollup of storefront_event, filled by
--     radar_rollup_traffic so the dashboard/detectors never row-fetch events
--     through PostgREST (1000-row clamp).
--  2. radar_ploy: drafted moves (merchant-facing label: "move"; the noun "ploy"
--     exists only in identifiers, never UI strings). Partial unique index keeps
--     one OPEN draft per (shop, kind, dedup_key) while letting dismissed rows
--     age out instead of blocking the move forever.
--  3. radar_state: radar-owned per-shop cron cursors + Home-card dismissal.
--     Server-only (no app_web grant): nothing browser-reachable needs it.
-- All three follow the storefront-facing tenant convention: self-contained RLS
-- via public.current_shop_id(); intentionally NOT added to the frozen
-- app/lib/security/tenant-tables.ts census. Phase D adds radar_competitor /
-- radar_snapshot in its own migration.

create table if not exists public.radar_traffic_daily (
  shop_id    uuid not null references public.shops(id) on delete cascade,
  day        date not null,
  views      integer not null default 0,
  sessions   integer not null default 0,
  cart_adds  integer not null default 0,
  checkouts  integer not null default 0,
  top_paths  jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (shop_id, day)
);

alter table public.radar_traffic_daily enable row level security;
drop policy if exists radar_traffic_daily_shop_scope on public.radar_traffic_daily;
create policy radar_traffic_daily_shop_scope on public.radar_traffic_daily
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.radar_traffic_daily from anon, authenticated;
grant select on table public.radar_traffic_daily to app_web;

create table if not exists public.radar_ploy (
  id                 uuid primary key default gen_random_uuid(),
  shop_id            uuid not null references public.shops(id) on delete cascade,
  kind               text not null check (kind in (
    'seo_regression_patch','seo_meta_rewrite','seo_content_boost',
    'aeo_refresh','aeo_jsonld_fix','section_refresh')),
  status             text not null default 'draft'
                     check (status in ('draft','applied','dismissed','expired')),
  headline           text not null,
  rationale          text not null,
  evidence           jsonb not null default '{}'::jsonb,
  payload            jsonb not null default '{}'::jsonb,
  dedup_key          text not null,
  prior_state        jsonb,
  applied_state_hash text,
  created_at         timestamptz not null default now(),
  applied_at         timestamptz,
  resolved_at        timestamptz,
  expires_at         timestamptz not null default now() + interval '14 days'
);

-- One OPEN draft per signal; a dismissed/expired row must not block re-drafting
-- forever (the drafter enforces the 30/14-day cooldowns in code).
create unique index if not exists radar_ploy_draft_dedup_idx
  on public.radar_ploy (shop_id, kind, dedup_key) where status = 'draft';
create index if not exists radar_ploy_shop_status_idx
  on public.radar_ploy (shop_id, status, created_at desc);

alter table public.radar_ploy enable row level security;
drop policy if exists radar_ploy_shop_scope on public.radar_ploy;
create policy radar_ploy_shop_scope on public.radar_ploy
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.radar_ploy from anon, authenticated;
grant select on table public.radar_ploy to app_web;

create table if not exists public.radar_state (
  shop_id                uuid primary key references public.shops(id) on delete cascade,
  last_collected_at      timestamptz,
  last_drafted_at        timestamptz,
  home_card_dismissed_at timestamptz,
  updated_at             timestamptz not null default now()
);

alter table public.radar_state enable row level security;
drop policy if exists radar_state_shop_scope on public.radar_state;
create policy radar_state_shop_scope on public.radar_state
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.radar_state from anon, authenticated;
-- Intentionally NO app_web grant: cron cursors + card dismissal are read and
-- written only by service-role server code.

-- Server-side traffic rollup. Idempotent upsert on (shop_id, day); re-running a
-- night re-covers the same window, so a killed cron tick loses nothing.
create or replace function public.radar_rollup_traffic(p_shop uuid, p_days int default 10)
returns integer
language sql
volatile
security definer
set search_path = public
as $$
  with days as (
    select generate_series(current_date - (p_days - 1), current_date, interval '1 day')::date as day
  ),
  ev as (
    select created_at::date as day, type, session_id, path, product_id
    from public.storefront_event
    where shop_id = p_shop
      and created_at >= (current_date - (p_days - 1))::timestamptz
  ),
  daily as (
    select d.day,
           count(*) filter (where e.type = 'page_view')         as views,
           count(distinct e.session_id)                          as sessions,
           count(*) filter (where e.type = 'cart_add')           as cart_adds,
           count(*) filter (where e.type = 'checkout_complete')  as checkouts
    from days d
    left join ev e on e.day = d.day
    group by d.day
  ),
  ranked_paths as (
    select e.day, e.path,
           count(*) filter (where e.type = 'page_view') as views,
           count(*) filter (where e.type = 'cart_add')  as cart_adds,
           max(e.product_id)                            as product_id,
           row_number() over (
             partition by e.day
             order by count(*) filter (where e.type = 'page_view') desc, e.path
           ) as rn
    from ev e
    group by e.day, e.path
  ),
  paths as (
    select day,
           jsonb_agg(jsonb_build_object(
             'path', path, 'views', views, 'cartAdds', cart_adds,
             'productId', product_id) order by views desc) as top_paths
    from ranked_paths
    where rn <= 20
    group by day
  ),
  up as (
    insert into public.radar_traffic_daily
      (shop_id, day, views, sessions, cart_adds, checkouts, top_paths, updated_at)
    select p_shop, d.day, d.views, d.sessions, d.cart_adds, d.checkouts,
           coalesce(p.top_paths, '[]'::jsonb), now()
    from daily d
    left join paths p on p.day = d.day
    on conflict (shop_id, day) do update
      set views = excluded.views, sessions = excluded.sessions,
          cart_adds = excluded.cart_adds, checkouts = excluded.checkouts,
          top_paths = excluded.top_paths, updated_at = now()
    returning 1
  )
  select count(*)::int from up;
$$;
revoke execute on function public.radar_rollup_traffic(uuid, int) from public, anon, authenticated;

-- Bounded ranking series for the TS detectors: top 50 (page,query) pairs by
-- 28-day impressions, each with its last-14-day daily points. seo_ranking can
-- hold 1000 rows/day, so this must aggregate server-side.
create or replace function public.read_radar_ranking_series(p_shop uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
with recent as (
  select * from public.seo_ranking
  where shop_id = p_shop and captured_date >= current_date - 28
),
pairs as (
  select page_url, query, sum(impressions) as imp
  from recent
  group by page_url, query
  order by imp desc
  limit 50
),
series as (
  select r.page_url, r.query,
         jsonb_agg(jsonb_build_object(
           'day', to_char(r.captured_date, 'YYYY-MM-DD'),
           'position', round(r.position::numeric, 1),
           'impressions', r.impressions,
           'clicks', r.clicks,
           'ctr', round(r.ctr::numeric, 4)) order by r.captured_date) as days
  from recent r
  join pairs p on p.page_url = r.page_url and p.query = r.query
  where r.captured_date >= current_date - 14
  group by r.page_url, r.query
)
select coalesce(
  (select jsonb_agg(jsonb_build_object('pageUrl', page_url, 'query', query, 'days', days)) from series),
  '[]'::jsonb);
$$;
revoke execute on function public.read_radar_ranking_series(uuid) from public, anon, authenticated;

-- Drain queue with per-shop fairness: order by the matching radar_state cursor,
-- nulls (never-processed shops) first, so a budget-limited cron run leaves the
-- skipped shops at the FRONT of the next run (same fairness rule as
-- cron.seo-rankings' gsc_last_pulled_at ordering). Only shops with a Radar-
-- relevant signal are drained; a shop with no traffic, no GSC and no AI-crawler
-- hits has nothing to detect and would only burn the time budget.
create or replace function public.radar_shop_queue(p_for text, p_limit int default 500)
returns table (shop_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select s.id
  from public.shops s
  left join public.radar_state rs on rs.shop_id = s.id
  where exists (select 1 from public.storefront_event e
                where e.shop_id = s.id and e.created_at >= now() - interval '30 days')
     or exists (select 1 from public.seo_settings st
                where st.shop_id = s.id and st.gsc_connected)
     or exists (select 1 from public.seo_ai_crawl_daily c
                where c.shop_id = s.id and c.day >= current_date - 30)
  order by (case when p_for = 'draft' then rs.last_drafted_at else rs.last_collected_at end)
           asc nulls first,
           s.id
  limit p_limit;
$$;
revoke execute on function public.radar_shop_queue(text, int) from public, anon, authenticated;

-- Self-tests: fail the apply if any invariant is missing.
do $$
begin
  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'radar_traffic_daily' and rowsecurity = true) then
    raise exception 'radar_traffic_daily is missing RLS';
  end if;
  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'radar_ploy' and rowsecurity = true) then
    raise exception 'radar_ploy is missing RLS';
  end if;
  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'radar_state' and rowsecurity = true) then
    raise exception 'radar_state is missing RLS';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'radar_ploy_draft_dedup_idx') then
    raise exception 'radar_ploy_draft_dedup_idx (partial dedup index) was not created';
  end if;
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'radar_state' and grantee = 'app_web'
  ) then
    raise exception 'radar_state must NOT be granted to app_web (server-only cursor table)';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'radar_rollup_traffic'
  ) then
    raise exception 'radar_rollup_traffic was not created';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'radar_shop_queue'
  ) then
    raise exception 'radar_shop_queue was not created';
  end if;
end $$;
