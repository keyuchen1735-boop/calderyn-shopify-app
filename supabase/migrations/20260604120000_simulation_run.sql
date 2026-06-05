-- simulation_run: one synthetic-shopper simulation. `model` holds the Claude-built
-- behavior model (archetypes + per-stage probabilities + findings); the slider
-- re-samples from it client-side. Shop-scoped in code (service-role).

create table simulation_run (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references shops(id) on delete cascade,
  status        text not null default 'queued'
                  check (status in ('queued','running','done','error')),
  target        text not null default 'whole_store',
  requested_n   integer not null default 1000
                  check (requested_n between 10 and 1000),
  model         jsonb,
  error         text,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);

-- Deny-by-default like the other business tables: the app reads/writes with the
-- service-role key (which bypasses RLS), so no policies are needed.
alter table simulation_run enable row level security;

create index simulation_run_shop_created_idx
  on simulation_run (shop_id, created_at desc);

-- Read view mirrors the v_*_view convention used elsewhere (e.g. v_alerts_view).
create view v_simulation_runs as
  select id, shop_id, status, target, requested_n, model, error, created_at, completed_at
  from simulation_run;
