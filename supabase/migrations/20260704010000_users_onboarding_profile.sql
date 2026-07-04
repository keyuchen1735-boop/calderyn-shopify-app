-- Post-signup onboarding profile on the first-party users table (email/Google signups).
-- Collected on the /dashboard/onboarding screen right after signup: contact phone,
-- how-the-merchant-heard-about-us (a fixed vocabulary + free-text 'other'), and the
-- onboarded_at stamp the dashboard's onboarding gate reads (NULL => not yet onboarded).
-- Shopify-connect (shop-based) sessions have no users row and are exempt by construction.
--
-- referral_source is a closed vocabulary enforced with a CHECK (repo convention: no native
-- enum type); referral_source_other holds the free text only when the source is 'other'.
-- All columns are nullable so the row is created at signup and filled at onboarding.
alter table public.users
  add column if not exists phone text,
  add column if not exists referral_source text,
  add column if not exists referral_source_other text,
  add column if not exists onboarded_at timestamptz;

alter table public.users drop constraint if exists users_referral_source_check;
alter table public.users add constraint users_referral_source_check
  check (referral_source is null or referral_source in (
    'google_search','shopify_app_store','twitter_x','linkedin','youtube',
    'tiktok_instagram','friend_colleague','other'
  ));

-- Backfill: existing users predate onboarding — mark them onboarded so the gate never
-- retro-forces them through it on next login. New rows keep onboarded_at NULL.
update public.users set onboarded_at = now() where onboarded_at is null;
