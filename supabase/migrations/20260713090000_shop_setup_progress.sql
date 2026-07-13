-- supabase/migrations/20260713090000_shop_setup_progress.sql
-- Guided-journey onboarding: sticky per-shop milestone completions.
-- Rows are derived from existing data by app/lib/onboarding/journey.server.ts
-- and only ever INSERTED — deleting the underlying record later never
-- un-completes a step. Also holds UI marker rows (…_dismissed).
create table if not exists shop_setup_progress (
  shop_id uuid not null references shops(id) on delete cascade,
  milestone_key text not null,
  completed_at timestamptz not null default now(),
  primary key (shop_id, milestone_key)
);

alter table shop_setup_progress enable row level security;
-- Service-role only (same posture as assistant_* tables): no anon/authenticated
-- policies on purpose.
revoke all on table public.shop_setup_progress from anon, authenticated;
