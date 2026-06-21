-- Autopilot concurrency lock (I6): per-shop "run in progress" row.
-- A cron tick acquires the lock by inserting a row. If a row already exists
-- for this shop_id and is younger than TTL_SECONDS, the tick is skipped.
-- The lock is released by deleting the row when the tick finishes (or errors).
--
-- Rationale: Supabase uses PgBouncer in Transaction mode by default. Advisory
-- locks (pg_try_advisory_lock) are session-scoped — in Transaction mode the
-- connection is returned to the pool between statements, so the advisory lock
-- is immediately released and provides NO protection. The TTL-row approach is
-- atomic (ON CONFLICT DO NOTHING) and works correctly over any connection pool.
--
-- RLS: service_role only (no anon/authenticated access).
-- Row is deleted by the tick on completion/error; an orphaned row expires after
-- TTL_MINUTES (see autopilot-lock.server.ts acquire logic).

create table if not exists public.autopilot_run_lock (
  shop_id     uuid        not null primary key references public.shops(id) on delete cascade,
  locked_at   timestamptz not null default now()
);

-- Only service_role may access this table.
alter table public.autopilot_run_lock enable row level security;

-- No RLS policies = no access for authenticated/anon roles.
-- service_role bypasses RLS entirely (Supabase behaviour).
