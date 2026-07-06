-- Two curated storefront design levers the CSS packs key off, alongside vibe:
-- type_style ([data-type] font pairing) and density ([data-density] spacing).
-- Defaults reproduce today's rendering (classic defers to vibe's font; standard
-- = current spacing), so existing rows are unaffected.
alter table public.store_settings
  add column if not exists type_style text not null default 'classic'
    check (type_style in ('classic','editorial','rounded'));

alter table public.store_settings
  add column if not exists density text not null default 'standard'
    check (density in ('compact','standard','roomy'));
