-- Collapse the shops.onboarding_step CHECK constraint to the 5-step redesign.
--
-- The onboarding wizard was redesigned (2026-06) from 9 steps to 5: the four
-- ad/accounting OAuth providers (google/meta/tiktok/quickbooks) collapsed into a
-- single "connect" step, and the creative_mapping step was dropped. The step NAME
-- is persisted to shops.onboarding_step, so advance() now writes 'connect', which
-- the prior 9-value CHECK (20260613120000_onboarding_step_tiktok.sql) rejects.
--
-- Order matters: DROP the old constraint FIRST, otherwise the normalization UPDATE
-- (rewriting now-removed names to 'connect') is itself rejected by the still-active
-- old constraint, which does not list 'connect'. Then normalize, then add the new
-- constraint. Merchants mid-provider-connect (or on creative_mapping) map to the
-- consolidated 'connect' step; shopify/guardrails/consent/complete are unchanged and
-- already valid. NULL is permitted (NULL IN (...) is NULL, not false).
--
-- Mirrors STEPS in app/routes/app.onboarding.tsx and ONBOARDING_STEPS in
-- app/lib/calderyn.server.ts. Apply this only WITH the redesigned onboarding code:
-- adding the new constraint before the new code deploys would reject the old
-- wizard's writes (e.g. 'meta') on a DB that still runs the old onboarding.
alter table public.shops
  drop constraint if exists shops_onboarding_step_check;

update public.shops
  set onboarding_step = 'connect'
  where onboarding_step in ('google', 'meta', 'tiktok', 'quickbooks', 'creative_mapping');

alter table public.shops
  add constraint shops_onboarding_step_check
  check (onboarding_step in (
    'shopify',
    'guardrails',
    'connect',
    'consent',
    'complete'
  ));
