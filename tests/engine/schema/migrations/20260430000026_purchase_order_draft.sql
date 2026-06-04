-- supabase/migrations/20260430000026_purchase_order_draft.sql
--
-- Plan 04 Task 14 — purchase_order_draft table backing the create_po_draft
-- executor (apps/web/app/lib/executors/createPoDraft.server.ts).
--
-- Status string column rather than an enum to keep options open for future
-- workflow states without a follow-up `alter type` migration; the executor
-- and reverser only ever write 'draft' or 'cancelled'.

create table if not exists public.purchase_order_draft (
  id                       uuid primary key default gen_random_uuid(),
  shop_id                  uuid not null references public.shops(id) on delete cascade,
  sku_id                   uuid not null references public.sku_dim(id) on delete cascade,
  vendor                   text not null,
  quantity                 int  not null check (quantity > 0),
  expected_unit_cost_cents int  not null check (expected_unit_cost_cents >= 0),
  status                   text not null default 'draft'
                                check (status in ('draft','sent','cancelled')),
  created_at               timestamptz not null default now(),
  cancelled_at             timestamptz
);

create index if not exists po_draft_shop_idx
  on public.purchase_order_draft (shop_id, status);

alter table public.purchase_order_draft enable row level security;

create policy po_draft_shop_scope on public.purchase_order_draft
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
