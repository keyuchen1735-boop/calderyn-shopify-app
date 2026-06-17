-- 3PL ship-cost connector, Phase 1: schema deltas for the synthetic connector period.
-- (Contract 00-overview §4 / Plan 01 §7.) Idempotent throughout so re-runs are safe.

-- 1. Allow the synthetic connector period source (D1). Non-period carrier charges
--    satisfy shipping_invoice_line.period_id NOT NULL via an auto-created per-(shop,
--    provider) period stamped source='connector'. Postgres has no
--    ADD CONSTRAINT IF NOT EXISTS; drop-then-add keeps it idempotent (same pattern the
--    base table uses, 20260616120000_true_ship_cost.sql:11-19). The named constraint
--    that ships in the base migration is shipping_cost_period_source_check.
alter table public.shipping_cost_period
  drop constraint if exists shipping_cost_period_source_check,
  add constraint shipping_cost_period_source_check
    check (source in ('upload','typed','connector'));

-- 2. Race-safe / idempotent synthetic period: at most one per (shop, carrier) for
--    connector rows, so the landing pipeline's get-or-create can never duplicate the
--    synthetic period under concurrent cron runs. Partial index scoped to connector
--    rows only — upload/typed periods are intentionally unconstrained (a shop can have
--    many of those).
create unique index if not exists shipping_cost_period_connector_uidx
  on public.shipping_cost_period (shop_id, carrier)
  where source = 'connector';

-- 3. Additive idempotency anchor (contract §8.2). The connector re-pulls a trailing
--    window each cron tick and replaces rows in place; the provider's stable charge id
--    (e.g. EasyPost shp_...) is the durable key for that replace. Strictly additive,
--    nullable, no constraint — the CSV/typed paths never set it, so zero backfill. A
--    later UNIQUE (shop_id, external_charge_id) onConflict upsert (Phase 3) needs no
--    migration of existing rows because the column already exists.
alter table public.shipping_invoice_line
  add column if not exists external_charge_id text;

-- Partial index supports the delete-by-(period_id, external_charge_id set) replace and a
-- future onConflict; scoped to non-null rows so CSV/typed lines don't bloat it.
create index if not exists shipping_invoice_line_external_charge_idx
  on public.shipping_invoice_line (shop_id, external_charge_id)
  where external_charge_id is not null;
