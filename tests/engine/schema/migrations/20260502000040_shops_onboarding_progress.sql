-- supabase/migrations/20260502000040_shops_onboarding_progress.sql
--
-- Plan 06 Task 3 — onboarding progress tracking on public.shops.
--
-- The merchant works through a fixed sequence of onboarding steps; we want a
-- single source of truth for "where are they right now" and a pair of
-- timestamps for "started" and "completed" so the dashboard can branch on
-- whether onboarding is finished without joining additional tables.
--
-- Columns:
--   onboarding_started_at    nullable; set when the merchant first lands on
--                            /app/onboarding/* (or when the install hook
--                            seeds the row).
--   onboarding_completed_at  nullable; set when onboarding_step transitions
--                            to 'complete'. The dashboard route uses
--                            (onboarding_completed_at IS NULL) to decide
--                            whether to redirect into the stepper.
--   onboarding_step          enum-like check; default 'shopify' so a
--                            freshly-installed shop lands on the first step
--                            even if the install hook never wrote anything.

alter table public.shops
  add column if not exists onboarding_started_at timestamptz,
  add column if not exists onboarding_completed_at timestamptz,
  add column if not exists onboarding_step text not null default 'shopify';

-- Constrain the step column to the eight known states. We use a CHECK
-- rather than an enum so we can add steps later without an enum-rewrite.
alter table public.shops
  drop constraint if exists shops_onboarding_step_check;
alter table public.shops
  add constraint shops_onboarding_step_check
  check (onboarding_step in (
    'shopify',
    'meta',
    'google',
    'quickbooks',
    'guardrails',
    'consent',
    'creative_mapping',
    'complete'
  ));
