-- Fulfillment + merchant order-management spine (orders close-out phase 1):
-- fulfillments with tracking, staff notes, tags, archive/cancel stamps, and the
-- partially_fulfilled state. Shop-scoped + RLS like every order-spine table.

-- 1) State vocabulary: partially_fulfilled between paid and fulfilled.
alter table public.orders drop constraint if exists orders_state_check;
alter table public.orders add constraint orders_state_check
  check (state in ('cart','checkout_pending','paid','partially_fulfilled','fulfilled','cancelled','refunded','partially_refunded'));

-- 2) Merchant lifecycle stamps on orders.
alter table public.orders add column if not exists archived_at timestamptz;
alter table public.orders add column if not exists cancelled_at timestamptz;
alter table public.orders add column if not exists cancel_reason text;

-- 3) fulfillment: one shipment record (whole or partial) with optional tracking.
create table if not exists public.fulfillment (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  status text not null default 'shipped' check (status in ('shipped')),
  tracking_number text,
  carrier text,
  tracking_url text,
  notified_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists fulfillment_order_idx on public.fulfillment (shop_id, order_id);
alter table public.fulfillment enable row level security;
create policy fulfillment_shop_scope on public.fulfillment
  for all using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());
revoke all on table public.fulfillment from anon, authenticated;

-- 4) fulfillment_line: which order lines (and how many units) each fulfillment covers.
create table if not exists public.fulfillment_line (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  fulfillment_id uuid not null references public.fulfillment(id) on delete cascade,
  order_line_id uuid not null references public.order_line(id) on delete cascade,
  quantity int not null check (quantity > 0)
);
create index if not exists fulfillment_line_f_idx on public.fulfillment_line (shop_id, fulfillment_id);
create index if not exists fulfillment_line_ol_idx on public.fulfillment_line (shop_id, order_line_id);
alter table public.fulfillment_line enable row level security;
create policy fulfillment_line_shop_scope on public.fulfillment_line
  for all using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());
revoke all on table public.fulfillment_line from anon, authenticated;

-- 5) order_note: append-only staff notes shown in the order timeline.
create table if not exists public.order_note (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  author_email text not null,
  body text not null check (length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists order_note_order_idx on public.order_note (shop_id, order_id);
alter table public.order_note enable row level security;
create policy order_note_shop_scope on public.order_note
  for all using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());
revoke all on table public.order_note from anon, authenticated;

-- 6) order_tag: flat tags; filtering ships with the phase-2 list power tools.
create table if not exists public.order_tag (
  shop_id uuid not null references public.shops(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  tag text not null check (length(tag) between 1 and 60),
  created_at timestamptz not null default now(),
  primary key (shop_id, order_id, tag)
);
alter table public.order_tag enable row level security;
create policy order_tag_shop_scope on public.order_tag
  for all using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());
revoke all on table public.order_tag from anon, authenticated;

-- 7) Audit vocabulary for the new merchant actions.
alter type public.action_kind add value if not exists 'fulfill_order';
alter type public.action_kind add value if not exists 'cancel_order';
