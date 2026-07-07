-- Add a second, independent crawler switch to seo_settings: allow_search_engines
-- governs standard search crawlers (Google, Bing, ...) via robots.txt `User-agent: *`,
-- mirroring the existing allow_ai_crawlers switch for AI assistants. Both default
-- to true (the product default: a new store is findable everywhere).
alter table public.seo_settings
  add column if not exists allow_search_engines boolean not null default true;
