-- Slice 1: TikTok ad-platform support.
-- ad_platform gains 'tiktok'; integration_kind gains 'tiktok_ads'.
-- ALTER TYPE ... ADD VALUE is idempotent-guarded with IF NOT EXISTS so re-runs
-- are safe. Note: a newly added enum value cannot be used in the same
-- transaction it is added in — this migration only alters the types.
alter type public.ad_platform add value if not exists 'tiktok';
alter type public.integration_kind add value if not exists 'tiktok_ads';
