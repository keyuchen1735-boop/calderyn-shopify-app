-- Rankings summary for the Search screen Google card (Radar Phase B).
-- One RPC so the dashboard never row-fetches seo_ranking through PostgREST
-- (1000-row clamp). SECURITY DEFINER, pinned search_path, EXECUTE revoked
-- from anon/authenticated; the service-role dashboard loader is the caller.
create or replace function public.read_seo_rankings_summary(p_shop uuid)
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
totals as (
  select coalesce(sum(clicks),0)::int as clicks,
         coalesce(sum(impressions),0)::int as impressions,
         max(captured_date) as last_day
  from recent
),
top_queries as (
  select query,
         sum(clicks)::int as clicks,
         round(avg(position)::numeric, 1) as position
  from recent
  group by query
  order by sum(clicks) desc, sum(impressions) desc
  limit 5
),
per_page as (
  select page_url, query,
         avg(position) filter (where captured_date >= current_date - 7) as cur_pos,
         avg(position) filter (where captured_date < current_date - 7
                               and captured_date >= current_date - 14) as prev_pos,
         sum(impressions) as imp
  from recent
  group by page_url, query
),
slipping as (
  select page_url, query,
         round(cur_pos::numeric, 1) as position,
         round(prev_pos::numeric, 1) as prev_position
  from per_page
  where cur_pos is not null and prev_pos is not null
    and cur_pos - prev_pos >= 3
  order by (cur_pos - prev_pos) desc, imp desc
  limit 5
)
select jsonb_build_object(
  'clicks', (select clicks from totals),
  'impressions', (select impressions from totals),
  'topQueries', coalesce((select jsonb_agg(jsonb_build_object(
      'query', query, 'clicks', clicks, 'position', position)) from top_queries), '[]'::jsonb),
  'slipping', coalesce((select jsonb_agg(jsonb_build_object(
      'pageUrl', page_url, 'query', query, 'position', position,
      'prevPosition', prev_position)) from slipping), '[]'::jsonb),
  'lastCapturedDate', (select to_char(last_day, 'YYYY-MM-DD') from totals)
);
$$;

revoke execute on function public.read_seo_rankings_summary(uuid) from public, anon, authenticated;

do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'read_seo_rankings_summary'
  ) then
    raise exception 'read_seo_rankings_summary was not created';
  end if;
end $$;
