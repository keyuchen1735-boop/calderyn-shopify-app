-- One-time dashboard orientation for first-party accounts. A skip suppresses
-- the automatic prompt but remains distinguishable from completing the tour,
-- so the account-menu replay can still offer the full experience later.
alter table public.users
  add column if not exists product_tour_completed_at timestamptz,
  add column if not exists product_tour_skipped_at timestamptz;

-- Existing merchants already know the product. Mark them complete so the new
-- first-run experience only opens automatically for accounts created after
-- this migration lands.
update public.users
set product_tour_completed_at = now()
where product_tour_completed_at is null
  and product_tour_skipped_at is null;

comment on column public.users.product_tour_completed_at is
  'When the merchant finished the dashboard product tour.';
comment on column public.users.product_tour_skipped_at is
  'When the merchant dismissed the automatic dashboard product tour.';
