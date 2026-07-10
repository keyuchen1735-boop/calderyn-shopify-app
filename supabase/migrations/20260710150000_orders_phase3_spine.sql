-- Phase 3 spine: merchant drafts, invoice recovery stamps, line-edit audit, sale fallback.
alter table public.cart add column if not exists origin text;
alter table public.orders add column if not exists recovery_email_sent_at timestamptz;

create table if not exists public.order_line_edit (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  order_id uuid not null,
  order_line_id uuid not null,
  old_quantity int not null check (old_quantity > 0),
  new_quantity int not null check (new_quantity >= 0),
  refund_cents int not null default 0 check (refund_cents >= 0),
  reason text,
  created_at timestamptz not null default now(),
  foreign key (shop_id, order_id) references public.orders (shop_id, id) on delete cascade,
  foreign key (shop_id, order_line_id) references public.order_line (shop_id, id) on delete cascade,
  check (new_quantity < old_quantity)
);
create index if not exists order_line_edit_order_idx on public.order_line_edit (shop_id, order_id);
alter table public.order_line_edit enable row level security;
create policy order_line_edit_shop_scope on public.order_line_edit
  for all using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());
revoke all on table public.order_line_edit from anon, authenticated;

-- Paid-invoice stock decrement when no reservation was ever held. Relative,
-- FOR UPDATE-locked, idempotent on the caller's key. on_hand MAY go negative:
-- backorder-truth (mirrors inventory_reserve's backorder branch) beats hidden
-- oversell, and the inventory screen surfaces the negative number.
create or replace function public.inventory_sale_fallback(
  p_shop_id uuid, p_variant_id uuid, p_location_id uuid, p_qty int, p_idempotency_key text
) returns void language plpgsql set search_path = '' as $$
begin
  if p_qty < 1 then raise exception 'invalid_qty' using errcode = 'P0001'; end if;
  insert into public.inventory_balance (shop_id, variant_id, location_id, on_hand, version, updated_at)
    values (p_shop_id, p_variant_id, p_location_id, 0, 0, now())
    on conflict (variant_id, location_id) do nothing;
  perform 1 from public.inventory_balance
    where shop_id = p_shop_id and variant_id = p_variant_id and location_id = p_location_id
    for update;
  if exists (select 1 from public.inventory_ledger
             where shop_id = p_shop_id and idempotency_key = p_idempotency_key) then
    return;
  end if;
  update public.inventory_balance set on_hand = on_hand - p_qty, version = version + 1, updated_at = now()
    where shop_id = p_shop_id and variant_id = p_variant_id and location_id = p_location_id;
  insert into public.inventory_ledger (shop_id, variant_id, location_id, entry_type, qty, idempotency_key, reason, source)
    values (p_shop_id, p_variant_id, p_location_id, 'sale', -p_qty, p_idempotency_key, 'paid_without_hold', 'system');
end $$;
revoke all on function public.inventory_sale_fallback(uuid, uuid, uuid, int, text) from public, anon, authenticated;
