-- supabase/migrations/20260610120000_image_gen_event.sql
-- Cost guardrail for image generation: one row per generated image, used to
-- enforce per-shop and global daily caps on the shared Higgsfield account.
create table if not exists image_gen_event (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references shops(id) on delete cascade,
  day        date not null,
  created_at timestamptz not null default now()
);
create index if not exists image_gen_event_day_idx on image_gen_event (day);
create index if not exists image_gen_event_shop_day_idx on image_gen_event (shop_id, day);

-- Deny-by-default; the app uses the service role (which bypasses RLS), matching
-- the other screener tables.
alter table image_gen_event enable row level security;
