-- Per-shop toggle for storefront weather-merchandising (floating weather-relevant
-- products to the top of collection/all grids). Default true keeps the current
-- live behavior; a merchant can turn it off in Store > Preferences. Lives on
-- seo_settings alongside the other storefront-serving preferences.
alter table public.seo_settings
  add column if not exists weather_merchandising boolean not null default true;
