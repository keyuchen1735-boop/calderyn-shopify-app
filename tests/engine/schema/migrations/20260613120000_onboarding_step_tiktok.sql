-- Add 'tiktok' to the shops.onboarding_step CHECK constraint.
--
-- The onboarding wizard gained a TikTok Ads step (inserted after Meta). The
-- step NAME is persisted to shops.onboarding_step, so advance() would violate
-- the existing 8-value CHECK the moment a merchant reaches that step. Widen the
-- constraint to the 9 known states. Adding a permitted value is non-destructive
-- (a strict superset), so no data backfill is required.
--
-- Mirrors STEPS in app/routes/app.onboarding.tsx and ONBOARDING_STEPS in
-- app/lib/calderyn.server.ts. Kept in sync with the same file under
-- supabase/migrations/.

alter table public.shops
  drop constraint if exists shops_onboarding_step_check;
alter table public.shops
  add constraint shops_onboarding_step_check
  check (onboarding_step in (
    'shopify',
    'meta',
    'google',
    'tiktok',
    'quickbooks',
    'guardrails',
    'consent',
    'creative_mapping',
    'complete'
  ));
