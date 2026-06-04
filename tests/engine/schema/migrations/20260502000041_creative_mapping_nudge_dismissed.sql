-- supabase/migrations/20260502000041_creative_mapping_nudge_dismissed.sql
-- Plan 06 Task 21: track when a merchant dismisses the first-run creative
-- mapping nudge so we can hide the home-page Banner permanently after the
-- first dismiss. Nullable: NULL = banner still eligible to render.

alter table public.shops
  add column if not exists creative_mapping_nudge_dismissed_at timestamptz;
