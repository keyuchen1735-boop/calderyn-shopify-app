-- True Ship Cost foundation: per-order resolved ship cost + weight + anchors.
-- text+CHECK (not enum types) so phase-2 'actual_3pl' needs no ALTER TYPE.
alter table public.order_fact
  add column if not exists ship_cost_cents integer,
  add column if not exists ship_cost_source text
    check (ship_cost_source in
      ('actual_invoice','actual_event','reconciled','modeled','fallback','manual')),
  add column if not exists ship_cost_confidence text
    check (ship_cost_confidence in ('high','med','low')),
  add column if not exists ship_cost_reconciled_at timestamptz;

alter table public.order_line_fact add column if not exists grams integer;
alter table public.sku_dim         add column if not exists grams integer;

create table if not exists public.shipping_cost_period (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null,
  period_start date not null,
  period_end   date not null,
  carrier      text,
  total_cents  bigint not null,
  source       text not null check (source in ('upload','typed')),
  created_at   timestamptz not null default now()
);
create index if not exists shipping_cost_period_shop_idx
  on public.shipping_cost_period (shop_id, period_start, period_end);

create table if not exists public.shipping_invoice_line (
  id              uuid primary key default gen_random_uuid(),
  shop_id         uuid not null,
  period_id       uuid references public.shipping_cost_period(id) on delete cascade,
  order_ref       text,
  tracking_no     text,
  cost_cents      integer not null,
  matched_order_id uuid references public.order_fact(id) on delete set null,
  created_at      timestamptz not null default now()
);
create index if not exists shipping_invoice_line_shop_idx
  on public.shipping_invoice_line (shop_id, period_id);

-- RLS: deny-by-default. Both tables are accessed only via the service-role key
-- (BYPASSRLS), matching the pattern used by every other per-shop table in this
-- repo (oauth_state, dashboard_sessions, creative_screen_run, etc.).
-- Revoke anon/authenticated grants for defense-in-depth.
alter table public.shipping_cost_period   enable row level security;
alter table public.shipping_invoice_line  enable row level security;

revoke all on table public.shipping_cost_period  from anon, authenticated;
revoke all on table public.shipping_invoice_line from anon, authenticated;
