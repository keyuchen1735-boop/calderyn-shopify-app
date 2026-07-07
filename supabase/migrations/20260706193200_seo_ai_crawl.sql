-- Records AI-assistant crawler visits per store/day. The AIO analogue of Search Console:
-- there is no "AI console", so we count when known answer-engine bots read a tenant's pages.
create table public.seo_ai_crawl_daily (
  shop_id  uuid    not null references public.shops(id) on delete cascade,
  bot_name text    not null,
  day      date    not null default current_date,
  hits     integer not null default 0,
  primary key (shop_id, bot_name, day)
);
create index seo_ai_crawl_daily_shop_idx on public.seo_ai_crawl_daily (shop_id);

alter table public.seo_ai_crawl_daily enable row level security;
create policy seo_ai_crawl_daily_shop_scope on public.seo_ai_crawl_daily
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.seo_ai_crawl_daily from anon, authenticated;
grant select on table public.seo_ai_crawl_daily to app_web;

-- Atomic per-day increment. Server calls this with the service key (bypasses RLS); the
-- anon/authenticated lanes must not be able to inflate a competitor's counters.
create or replace function public.log_ai_crawl(p_shop_id uuid, p_bot text)
returns void
language sql
as $$
  insert into public.seo_ai_crawl_daily (shop_id, bot_name, day, hits)
  values (p_shop_id, p_bot, current_date, 1)
  on conflict (shop_id, bot_name, day)
  do update set hits = public.seo_ai_crawl_daily.hits + 1;
$$;
revoke execute on function public.log_ai_crawl(uuid, text) from anon, authenticated;

-- Self-test: RLS must be enabled, or fail the apply (mirrors the tenant_isolation_hardening pattern).
do $$
begin
  if not exists (
    select 1 from pg_tables where schemaname = 'public' and tablename = 'seo_ai_crawl_daily' and rowsecurity = true
  ) then
    raise exception 'seo_ai_crawl_daily is missing RLS';
  end if;
end $$;
