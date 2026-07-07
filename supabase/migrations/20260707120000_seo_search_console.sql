-- Google Search Console rankings loop (Plan C). Three changes:
--  1. seo_ranking: daily Search Analytics rows per store. Non-secret ranking
--     numbers; self-contained shop-scope RLS like seo_page / seo_ai_crawl_daily.
--  2. seo_settings: gsc_connected + gsc_site_url (non-secret connection state).
--  3. seo_google_credential: the encrypted Google refresh token. A DENY-ALL
--     secret table (RLS on, NO policy, NO app_web grant), reachable only by
--     service-role server code. Mirrors oauth_state / integration_credentials.
-- All three follow the storefront-facing tenant convention: RLS lives here in
-- the migration and these tables are intentionally NOT added to the frozen
-- app/lib/security/tenant-tables.ts census.

create table if not exists public.seo_ranking (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references public.shops(id) on delete cascade,
  query         text not null,
  page_url      text not null,
  position      numeric not null,
  impressions   integer not null default 0,
  clicks        integer not null default 0,
  ctr           numeric not null default 0,
  captured_date date not null,
  source        text not null default 'search_console',
  unique (shop_id, query, page_url, captured_date)
);
create index if not exists seo_ranking_shop_date_idx on public.seo_ranking (shop_id, captured_date);

alter table public.seo_ranking enable row level security;
drop policy if exists seo_ranking_shop_scope on public.seo_ranking;
create policy seo_ranking_shop_scope on public.seo_ranking
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.seo_ranking from anon, authenticated;
grant select on table public.seo_ranking to app_web;

-- Non-secret connection state on the existing per-shop settings row.
alter table public.seo_settings add column if not exists gsc_connected boolean not null default false;
alter table public.seo_settings add column if not exists gsc_site_url  text;

-- SECRET: the Google refresh token. Deny-all (RLS on, NO policy, NO app_web
-- grant); only the service-role key (BYPASSRLS) may read/write it.
create table if not exists public.seo_google_credential (
  shop_id                 uuid primary key references public.shops(id) on delete cascade,
  refresh_token_encrypted text not null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

alter table public.seo_google_credential enable row level security;
revoke all on table public.seo_google_credential from anon, authenticated;
-- Intentionally NO policy and NO grant to app_web: the encrypted refresh token
-- must never be readable by the dashboard read lane or any browser-reachable role.

-- Self-tests: fail the apply if any invariant is missing.
do $$
begin
  if not exists (select 1 from pg_tables where schemaname='public' and tablename='seo_ranking' and rowsecurity=true) then
    raise exception 'seo_ranking is missing RLS';
  end if;
  if not exists (select 1 from pg_tables where schemaname='public' and tablename='seo_google_credential' and rowsecurity=true) then
    raise exception 'seo_google_credential is missing RLS';
  end if;
  if exists (select 1 from pg_policies where schemaname='public' and tablename='seo_google_credential') then
    raise exception 'seo_google_credential must have NO RLS policy (deny-all secret table)';
  end if;
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema='public' and table_name='seo_google_credential' and grantee='app_web'
  ) then
    raise exception 'seo_google_credential must NOT be granted to app_web (secret table)';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='seo_settings' and column_name='gsc_connected') then
    raise exception 'seo_settings.gsc_connected was not added';
  end if;
end $$;
