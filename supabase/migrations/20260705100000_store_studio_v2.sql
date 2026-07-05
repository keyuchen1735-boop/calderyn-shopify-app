-- supabase/migrations/20260705100000_store_studio_v2.sql
-- Store Studio v2 (spec 2026-07-05-store-studio-v2-design.md): per-shop design
-- vibe, one-at-a-time home-page A/B experiments, and exposure stamping on
-- storefront_event. RLS follows the Step 10 tenant-isolation convention
-- (shop-scope policy, anon/authenticated revoked, service-role only).

-- D1: the design vibe the storefront CSS packs key off ([data-vibe]).
alter table public.store_settings
  add column if not exists vibe text not null default 'minimal'
    check (vibe in ('minimal','bold','warm'));

-- D4: one experiment at a time per shop, home page only in v1. The champion
-- stays in page_document.published_json; the challenger doc (and optional
-- settings overrides for arm B) live on this row so a decision can ship or
-- discard it without a history system.
create table if not exists public.store_experiment (
  id               uuid primary key default gen_random_uuid(),
  shop_id          uuid not null references public.shops(id) on delete cascade,
  page_key         text not null default 'home' check (page_key = 'home'),
  name             text not null,
  why              text not null default '',
  variant_doc      jsonb not null,
  variant_settings jsonb,
  state            text not null default 'running'
    check (state in ('running','decided_ship','decided_keep','stopped')),
  decision_note    text,
  started_at       timestamptz not null default now(),
  decided_at       timestamptz,
  created_at       timestamptz not null default now()
);

-- The one-at-a-time invariant: the partial unique index is the arbiter when
-- two starts race past the application-level check.
create unique index if not exists store_experiment_one_running
  on public.store_experiment (shop_id) where state = 'running';

alter table public.store_experiment enable row level security;
drop policy if exists store_experiment_shop_scope on public.store_experiment;
create policy store_experiment_shop_scope on public.store_experiment
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.store_experiment from anon, authenticated;

-- Exposure rides the existing page_view rows: nullable stamp columns, no type
-- CHECK change. The partial index serves the per-experiment report reads.
alter table public.storefront_event
  add column if not exists experiment_id uuid,
  add column if not exists variant_key text;
create index if not exists storefront_event_experiment_idx
  on public.storefront_event (shop_id, experiment_id, created_at desc)
  where experiment_id is not null;

-- Corrective for 20260629140000_store_generator.sql, which described 'failed'
-- as "reserved for a hard-failure path not yet emitted": the generator now
-- emits 'failed' as a SOFT degradation (deterministic fallback docs were still
-- written; the AI was unreachable). Comment only — no constraint change.
comment on column public.store_generation.status is
  'draft = docs written from the model plan; no_products = empty catalog, generation skipped; failed = soft degradation (AI unreachable, deterministic fallback docs still written and publishable).';
