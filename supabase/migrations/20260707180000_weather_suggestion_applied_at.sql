-- Executed-history support: stamp when an applied weather move actually ran.
-- The dashboard's Weather tab shows applied moves with "when and why"; rows
-- applied before this column existed stay out of that history (no fabricated
-- timestamps).
alter table weather_suggestion
  add column if not exists applied_at timestamptz;

create index if not exists weather_suggestion_applied_idx
  on weather_suggestion (shop_id, applied_at desc)
  where status = 'applied';
