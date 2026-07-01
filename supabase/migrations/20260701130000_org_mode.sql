-- org_mode: per-store cutover state machine + append-only transition audit.
-- shops.org_mode routes the store-mutating autopilot writers (price, inventory)
-- to Calderyn's own tables (only at `live`) vs the Shopify Admin API (every other
-- mode). Defaults to `mirror` so every existing shop keeps writing to Shopify and
-- this migration changes no live behavior until a shop is deliberately moved.
--
-- cutover_transition follows the service-role-only RLS pattern of the owned
-- intake/ledger tables (20260630170000_owned_event_ingest.sql): RLS enabled,
-- grants revoked, and NO current_shop_id() policy -- it is reached only via the
-- BYPASSRLS service-role client, so the INFO rls_enabled_no_policy advisor is
-- expected and intentional.

alter table public.shops
  add column if not exists org_mode text not null default 'mirror'
  check (org_mode in ('mirror', 'importing', 'dual_run', 'live'));

create table if not exists public.cutover_transition (
  id          uuid        primary key default gen_random_uuid(),
  shop_id     uuid        not null references public.shops(id) on delete cascade,
  from_mode   text        not null,
  to_mode     text        not null,
  reason      text,
  occurred_at timestamptz not null default now()
);

create index if not exists cutover_transition_shop_idx
  on public.cutover_transition(shop_id);

alter table public.cutover_transition enable row level security;
revoke all on table public.cutover_transition from anon, authenticated;
