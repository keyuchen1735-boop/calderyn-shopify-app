-- Test-DB parity for supabase/migrations/20260620160000_pair_calibration.sql
-- Mirrors the production migration so the RLS-guard test can run against the
-- test Postgres container (see tests/engine/scripts/test-db.sh).

create table if not exists public.pair_calibration (
  shop_id                       uuid    not null references public.shops(id) on delete cascade,
  detector_id                   text    not null,
  action_kind                   public.action_kind not null,
  alpha                         numeric not null default 0,
  beta                          numeric not null default 0,
  clean_approvals               integer not null default 0,
  consecutive_clean_approvals   integer not null default 0,
  consecutive_undos             integer not null default 0,
  graduation_threshold          integer not null default 75,
  merchant_disabled             boolean not null default false,
  graduated                     boolean not null default false,
  last_conf                     integer not null default 0,
  last_detection                numeric not null default 0,
  updated_at                    timestamptz not null default now(),
  primary key (shop_id, detector_id, action_kind)
);

create index if not exists pair_calibration_shop_idx
  on public.pair_calibration (shop_id);

alter table public.pair_calibration enable row level security;
alter table public.pair_calibration force row level security;

create policy pair_calibration_scope on public.pair_calibration
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());

-- calibration_pct / calibration_updated_at headline columns on shops
alter table public.shops
  add column if not exists calibration_pct integer,
  add column if not exists calibration_updated_at timestamptz;
