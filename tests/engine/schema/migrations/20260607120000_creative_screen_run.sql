-- creative_screen_run: one ad-creative pre-screen. `scorecard` holds the scored
-- + calibrated result (composite, grade, metrics with reasoning, predicted
-- outcomes, tips). Shop-scoped in code (service-role).

create table creative_screen_run (
  id                   uuid primary key default gen_random_uuid(),
  shop_id              uuid not null references shops(id) on delete cascade,
  status               text not null default 'running'
                         check (status in ('running','done','error')),
  source               text not null default 'manual'
                         check (source in ('manual','meta_ad')),
  meta_ad_id           text,
  mapped_sku_id        uuid references sku_dim(id),
  assumed_spend_cents  integer not null default 50000,
  scorecard            jsonb,
  error                text,
  created_at           timestamptz not null default now(),
  completed_at         timestamptz
);

-- Deny-by-default: the app reads/writes with the service-role key (bypasses RLS).
alter table creative_screen_run enable row level security;

create index creative_screen_run_shop_created_idx
  on creative_screen_run (shop_id, created_at desc);

-- Read view mirrors the v_*_view convention. `scorecard` is heavy; list queries
-- select columns explicitly and omit it.
create view v_creative_screen_runs as
  select id, shop_id, status, source, meta_ad_id, mapped_sku_id,
         assumed_spend_cents, scorecard, error, created_at, completed_at
  from creative_screen_run;
