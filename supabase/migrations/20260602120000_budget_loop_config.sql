-- Ad-budget reallocation loop: per-shop loop settings, overlap lock, move ledger.
-- Supabase-managed schema (not Prisma) per the ingestion/actions spec carve-out.

-- Loop settings live alongside the existing guardrail config. All defaulted so
-- existing shops keep working without a backfill.
alter table guardrail_config
  add column if not exists target_roas        numeric not null default 2.0,
  add column if not exists budget_step_pct    numeric not null default 0.20,
  add column if not exists budget_floor_cents integer not null default 500,
  add column if not exists budget_ceiling_pct numeric not null default 0.20,
  add column if not exists lose_band          numeric not null default 0.90,
  add column if not exists win_band           numeric not null default 1.20,
  add column if not exists min_spend_7d_cents integer not null default 2000;

-- Overlap guard: one budget-loop tick per shop at a time. Claimed by insert
-- (PK conflict => another tick owns the shop), released in a finally block,
-- reclaimable after a stale timeout enforced in code.
create table if not exists budget_loop_lock (
  shop_id   uuid primary key references shops(id) on delete cascade,
  locked_at timestamptz not null
);

-- Atomic per-move reservation (idempotency). The composite PK makes the loop's
-- pre-Meta INSERT conflict (and thus skip) when a move was already claimed this
-- tick, closing the check-then-act race. Keys are tick-bucketed, so old rows are
-- inert and can be pruned by a later housekeeping job.
create table if not exists budget_move_ledger (
  shop_id         uuid not null references shops(id) on delete cascade,
  idempotency_key text not null,
  applied_at      timestamptz not null,
  primary key (shop_id, idempotency_key)
);
