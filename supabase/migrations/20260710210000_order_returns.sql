-- Merchant-recorded returns (orders Phase 4, Task 1): the RMA spine — a return is opened against
-- an already-shipped order, its lines record the requested quantity/restock/refund, and receiving
-- it restocks + refunds through the SAME executors edit_order/issue_refund already use (idempotency
-- lanes, CAS status flips). Mirrors order_line_edit's shape (migration 20260710150000/180000):
-- composite FKs into orders/order_line, shop-scoped RLS + revoke, own idempotency lane.
--
-- One open return per order (order_return_one_open, partial unique index): a second return cannot
-- be opened while one is still in flight, so returns.server.ts's returnable-quantity math never has
-- to reconcile two concurrently-open claims against the same fulfilled units.
--
-- Status lifecycle: open -> received -> closed, or open -> cancelled. v1's receive flow
-- (executeReturnReceivedAction) flips open -> closed DIRECTLY in one update, stamping received_at —
-- 'received' is kept as a distinct status value for a future async fulfillment-style flow (e.g. a
-- carrier-scan intake step between "buyer shipped it" and "warehouse counted it"), not used today.
create table if not exists public.order_return (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  order_id uuid not null,
  status text not null default 'open' check (status in ('open', 'received', 'closed', 'cancelled')),
  reason text,
  received_at timestamptz,
  -- Crash-window resume marker (mirrors order_line_edit.idempotency_key, migration 20260710180000):
  -- stamped atomically with the status flip to 'closed' so a retry of the SAME idempotency key that
  -- crashed AFTER the restock/refund committed but BEFORE its action_audit tail lands can detect
  -- "this key already finished the state change" and resume straight into the audit write, instead
  -- of re-deriving (and potentially re-rejecting) an over-refund check against an already-updated ledger.
  received_idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Composite FK target for order_return_line (same pattern as fulfillment's unique (shop_id, id)).
  unique (shop_id, id),
  foreign key (shop_id, order_id) references public.orders (shop_id, id) on delete cascade
);
create index if not exists order_return_order_idx on public.order_return (shop_id, order_id);
-- Only one return may be `open` for a given order at a time — createOrderReturn's second call for
-- the same order 23505s here, caught and surfaced as a typed 409 return_already_open.
create unique index if not exists order_return_one_open on public.order_return (shop_id, order_id) where status = 'open';
alter table public.order_return enable row level security;
create policy order_return_shop_scope on public.order_return
  for all using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());
revoke all on table public.order_return from anon, authenticated;

create table if not exists public.order_return_line (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  return_id uuid not null,
  order_line_id uuid not null,
  quantity int not null check (quantity > 0),
  -- Per-line restock choice at create time; honored by executeReturnReceivedAction at receive time,
  -- keyed `restockreturn:<this row's id>` so a retry of the SAME return-line can never double-restock.
  restock boolean not null default true,
  refund_cents int not null default 0 check (refund_cents >= 0),
  created_at timestamptz not null default now(),
  foreign key (shop_id, return_id) references public.order_return (shop_id, id) on delete cascade,
  foreign key (shop_id, order_line_id) references public.order_line (shop_id, id) on delete cascade
);
create index if not exists order_return_line_return_idx on public.order_return_line (shop_id, return_id);
alter table public.order_return_line enable row level security;
create policy order_return_line_shop_scope on public.order_return_line
  for all using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());
revoke all on table public.order_return_line from anon, authenticated;

-- Register the return_received action kind (executeReturnReceivedAction, app/lib/order/returns.server.ts
-- writes ONE action_audit row per receive with this kind) — the same "register before the first
-- write can reference it" ordering edit_order's migration (20260710180000) documents.
alter type public.action_kind add value if not exists 'return_received';

-- Cost snapshot (Phase 4 Task 3 profit read model consumes this; threaded in at line-build time by
-- checkout.server.ts/invoice.server.ts, Task 1). NO cost-snapshot pipeline exists anywhere before
-- this column — every population path (the two send paths above, plus this backfill for
-- already-existing order_line rows) is new. Nullable: a variant with no unit_cost_cents recorded
-- yet (or since deleted) snapshots null, never a fabricated 0.
alter table public.order_line add column if not exists unit_cost_cents_snapshot int;

-- Backfill existing order_line rows from the variant's CURRENT cost — the best available estimate
-- for a sale that predates this column; only touches rows that are still null so a later re-run
-- (or a row already populated by the live checkout/invoice paths) is never overwritten.
-- order_line.variant_id is TEXT (it also carries snapshot ids from non-catalog paths);
-- compare on the uuid cast TO text so a non-uuid variant_id can never throw.
update public.order_line ol
  set unit_cost_cents_snapshot = v.unit_cost_cents
  from public.variant_dim v
  where v.id::text = ol.variant_id
    and v.shop_id = ol.shop_id
    and ol.unit_cost_cents_snapshot is null
    and v.unit_cost_cents is not null;
