-- #9 rehost sweep bookkeeping (cron.assets). After the sweep captures a hotlinked
-- image into owned storage it rewrites external_url to the owned public URL and
-- preserves the original hotlink in source_url — the "already rehosted" marker and
-- the dedup key when a re-promote/re-pick re-inserts the same hotlink under the
-- (product_id, external_url) partial unique. rehost_attempts caps retries so a
-- permanently dead URL cannot clog the per-run budget forever; the row keeps
-- serving its hotlink (the browser may still resolve what our fetch could not).
alter table public.product_media add column if not exists source_url text;
alter table public.product_media add column if not exists rehost_attempts integer not null default 0;

comment on column public.product_media.source_url is
  'Original hotlink URL before the cron.assets rehost sweep rewrote external_url to the owned copy; null = not yet rehosted.';
comment on column public.product_media.rehost_attempts is
  'Failed rehost fetches so far; the sweep skips rows at 5+ (dead URL) instead of retrying nightly forever.';
