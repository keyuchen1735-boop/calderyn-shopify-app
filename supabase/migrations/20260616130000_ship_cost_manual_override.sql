-- True Ship Cost Part 2: per-order manual ship-cost override.
-- Plan 1's resolver already reads OrderSignals.manualOverrideCents (highest
-- precedence) but Plan 1 added no storage for it. This nullable column is that
-- storage; the runner (Task 2) reads it. Additive + idempotent so it is safe to
-- apply independently. order_fact already has RLS from Plan 1's migration; a new
-- nullable column inherits it, so no policy change is needed.
alter table public.order_fact
  add column if not exists ship_cost_manual_cents integer;

-- Shop-level ship-cost mode. One row per shop; 'auto' is the recommended default.
create table if not exists public.shop_settings (
  shop_id        uuid primary key references shops(id) on delete cascade,
  ship_cost_mode text not null default 'auto'
    check (ship_cost_mode in ('auto','force_measured','force_reconciled')),
  updated_at     timestamptz not null default now()
);
-- App reaches this only via the service-role key (BYPASSRLS); deny-all to other
-- roles, mirroring integration_credentials_rls.
alter table public.shop_settings enable row level security;
revoke all on table public.shop_settings from anon, authenticated;
