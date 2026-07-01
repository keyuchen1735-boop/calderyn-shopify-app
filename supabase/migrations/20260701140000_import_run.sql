-- Import-from-Shopify (#13.promote): per-merchant import job state.
-- A small state machine row (pulling -> promoting -> done/error) that the
-- dashboard polls and the ingest cron drains.
create table if not exists public.import_run (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  state text not null check (state in ('pulling','promoting','done','error')),
  since_days int not null default 365,
  counts jsonb not null default '{}'::jsonb,
  report jsonb,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists import_run_shop_idx on public.import_run(shop_id, started_at desc);

-- Only the backend service role touches this table; RLS + shop-scope policy is
-- defense-in-depth (matches acp_session / commerce_quote_core).
alter table public.import_run enable row level security;
revoke all on public.import_run from anon, authenticated;
drop policy if exists import_run_shop_scope on public.import_run;
create policy import_run_shop_scope on public.import_run
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
