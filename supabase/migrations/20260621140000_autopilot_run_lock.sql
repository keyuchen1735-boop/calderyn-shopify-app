-- Autopilot concurrency lock (I6): per-shop "run in progress" row.
-- A cron tick acquires the lock by issuing a plain INSERT via supabase-js.
-- The shop_id primary-key unique constraint makes exactly one concurrent INSERT
-- win; the loser receives a Postgres 23505 unique-violation error (not a silent
-- 0-row result -- supabase-js does not issue ON CONFLICT DO NOTHING). The app
-- branches on error code 23505 to detect "lock held -- skip this tick".
-- The lock is released by deleting the row (fenced on locked_at) when the tick
-- finishes or errors; an orphaned row from a crashed tick expires via TTL logic
-- in autopilot-lock.server.ts (LOCK_TTL_MS = 10 min).
--
-- Rationale: Supabase uses PgBouncer in Transaction mode by default. Advisory
-- locks (pg_try_advisory_lock) are session-scoped -- in Transaction mode the
-- connection is returned to the pool between statements, so the advisory lock
-- is immediately released and provides NO protection. The TTL-row approach
-- works correctly over any connection pool.
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
