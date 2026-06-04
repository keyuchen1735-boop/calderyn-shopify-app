-- Plan 05 Task 15 — moat.peer_baselines + peer_data_consent column.
--
-- ``peer_baselines`` is the cross-tenant rollup the engine reads when
-- it wants to tell a merchant "your margin is in the bottom quartile
-- of consenting peers in your category". We store p25/p50/p75 per
-- (detector_id, segment) — the segment is a free-form bucket key
-- (e.g. ``cat:electronics``, ``size:mid``, ``region:us``) chosen by
-- the ETL based on consenting-shop attributes.
--
-- ``n`` carries the contributor count so the engine can refuse to
-- show a baseline computed off too few shops (k-anonymity floor of 5
-- enforced at the ETL layer in Task 16). We persist it here so the
-- engine doesn't need a second round-trip to count.
--
-- Composite PK on (detector_id, segment) — one canonical baseline
-- row per slice; the ETL upserts in place.
--
-- The ``ALTER TABLE public.shops ADD COLUMN peer_data_consent`` is a
-- no-op when the column already exists (Plan 02's create_shops
-- migration ships the column with default false). We keep the
-- statement here as defensive scaffolding for fresh databases that
-- might land out-of-order migrations: ``ADD COLUMN IF NOT EXISTS``
-- guarantees idempotence.

create table moat.peer_baselines (
  detector_id text not null,
  segment     text not null,
  p25         numeric(18,6) not null,
  p50         numeric(18,6) not null,
  p75         numeric(18,6) not null,
  n           integer not null,
  computed_at timestamptz not null default now(),
  primary key (detector_id, segment),
  check (n >= 0)
);

-- Defensive idempotence — Plan 02 already shipped this column. Older
-- branches that ran Phase A migrations against a DB without Plan 02
-- still need a column to land here.
alter table public.shops
  add column if not exists peer_data_consent boolean not null default false;
