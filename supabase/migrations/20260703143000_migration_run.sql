-- migration_run: durable go-live gate fact (platform-pivot Step 9, #13). checkGoLiveGates
-- computes the parity + payment verdict on demand but persisted nothing; this table records
-- one row per hard gate evaluation (assertGoLiveGates, the enforcing dual_run->live path) so
-- the operator has an auditable trail of what the gate saw and when a cutover actually fired.
--   parity_json  — the full GateCheck[] the evaluation produced (expected vs actual per check)
--   payment_ok   — the payment-cleared gate verdict (a test order reached paid AND a Stripe
--                  charge captured), lifted out as a scalar for quick "was money proven" reads
--   verdict      — 'pass' when every check passed, else 'blocked' (mirrors GoLiveReport.pass)
--   operator     — who triggered the evaluation (white-glove pilot); null when unattributed
--   cutover_at   — stamped only when the ->live transition that this run gated actually
--                  committed (transitionOrgMode), so a passed-but-not-cut run is distinguishable
--                  from a live cutover.
-- Only the backend service role touches this table; RLS + shop-scope policy is defense-in-depth
-- (matches import_run / 20260702120000's posture).
create table if not exists public.migration_run (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  parity_json jsonb not null default '[]'::jsonb,
  payment_ok  boolean not null default false,
  verdict     text not null check (verdict in ('pass', 'blocked')),
  operator    text,
  created_at  timestamptz not null default now(),
  cutover_at  timestamptz
);

create index if not exists migration_run_shop_idx on public.migration_run(shop_id, created_at desc);

alter table public.migration_run enable row level security;
revoke all on public.migration_run from anon, authenticated;
drop policy if exists migration_run_shop_scope on public.migration_run;
create policy migration_run_shop_scope on public.migration_run
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
