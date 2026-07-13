-- campaign_wizard_runs: bookkeeping for the first-campaign wizard's Meta create.
-- One row per wizard run (id supplied by the client as a stable UUID), giving
-- the create route idempotency (a replayed POST with the same run id returns the
-- stored result instead of creating a second campaign on Meta) and rollback
-- bookkeeping (which Meta objects exist if a partial create failed).
--
-- Hardened-migration pattern, identical to campaign_draft (20260703010000): the
-- table carries its OWN shop_id; RLS `for all` with BOTH using + with check
-- against current_shop_id(); anon/authenticated grants revoked.

create table public.campaign_wizard_runs (
  id               uuid primary key,
  shop_id          uuid not null references public.shops(id) on delete cascade,
  status           text not null check (status in ('creating','created','rolled_back','failed')),
  input            jsonb not null,
  meta_campaign_id text,
  meta_adset_id    text,
  meta_ad_id       text,
  error            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (shop_id, id)
);
create index campaign_wizard_runs_shop_idx on public.campaign_wizard_runs (shop_id, created_at desc);

alter table public.campaign_wizard_runs enable row level security;
create policy campaign_wizard_runs_shop_scope on public.campaign_wizard_runs
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.campaign_wizard_runs from anon, authenticated;
