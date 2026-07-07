-- Merchant SEO overrides (seo_page) + per-shop SEO/AIO settings (seo_settings), Plan B.
-- seo_page is OVERRIDE-ONLY: a row exists only when a merchant hand-edited a page's
-- meta title/description. No row => the storefront serves the live engine draft (Plan A).
-- Both tables follow the storefront_event / seo_ai_crawl_daily tenant-isolation
-- convention: self-contained RLS via public.current_shop_id(); intentionally NOT added
-- to the frozen app/lib/security/tenant-tables.ts census.

create table if not exists public.seo_page (
  id               uuid primary key default gen_random_uuid(),
  shop_id          uuid not null references public.shops(id) on delete cascade,
  entity_type      text not null,
  entity_id        text not null,
  meta_title       text,
  meta_description text,
  updated_at       timestamptz not null default now(),
  updated_by       uuid,
  unique (shop_id, entity_type, entity_id)
);
create index if not exists seo_page_shop_idx on public.seo_page (shop_id);

alter table public.seo_page enable row level security;
drop policy if exists seo_page_shop_scope on public.seo_page;
create policy seo_page_shop_scope on public.seo_page
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.seo_page from anon, authenticated;
grant select on table public.seo_page to app_web;

create table if not exists public.seo_settings (
  shop_id           uuid primary key references public.shops(id) on delete cascade,
  allow_ai_crawlers boolean not null default true,
  allow_ai_training boolean not null default false,
  org_name          text,
  org_description   text,
  updated_at        timestamptz not null default now()
);

alter table public.seo_settings enable row level security;
drop policy if exists seo_settings_shop_scope on public.seo_settings;
create policy seo_settings_shop_scope on public.seo_settings
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.seo_settings from anon, authenticated;
grant select on table public.seo_settings to app_web;

-- Self-test: RLS must be enabled on both tables, or fail the apply (mirrors the
-- storefront_event / seo_ai_crawl_daily convention).
do $$
begin
  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'seo_page' and rowsecurity = true) then
    raise exception 'seo_page is missing RLS';
  end if;
  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'seo_settings' and rowsecurity = true) then
    raise exception 'seo_settings is missing RLS';
  end if;
end $$;
