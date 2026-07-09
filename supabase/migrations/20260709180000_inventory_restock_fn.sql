-- supabase/migrations/20260709180000_inventory_restock_fn.sql
-- Refund/cancel restock: put sold units back into on_hand as an atomic relative
-- increment (FOR UPDATE lock), journaled as a 'restock' ledger entry. Relative,
-- not absolute, so a restock racing a concurrent sale composes instead of
-- clobbering (same rule as inventory_mark_unavailable). Idempotency check runs
-- under the balance lock so concurrent same-key replays serialize and no-op
-- (mirrors inventory_receive_transfer's check-under-lock idiom).

alter table public.inventory_ledger drop constraint if exists inventory_ledger_entry_type_check;
alter table public.inventory_ledger add constraint inventory_ledger_entry_type_check
  check (entry_type in ('receive','adjust','transfer_out','transfer_in','in_transit','received','reserve','release','sale','mark_unavailable','restock'));

create or replace function public.inventory_restock(
  p_shop_id uuid, p_variant_id uuid, p_location_id uuid, p_qty int, p_idempotency_key text, p_reason text
) returns void language plpgsql set search_path = '' as $$
begin
  if p_qty < 1 then raise exception 'invalid_qty' using errcode = 'P0001'; end if;
  insert into public.inventory_balance (shop_id, variant_id, location_id, on_hand, version, updated_at)
    values (p_shop_id, p_variant_id, p_location_id, 0, 0, now())
    on conflict (variant_id, location_id) do nothing;
  perform 1 from public.inventory_balance
    where shop_id = p_shop_id and variant_id = p_variant_id and location_id = p_location_id
    for update;
  -- Dedup on the caller's key: a replayed refund/cancel must not double-restock.
  -- Check runs under the lock so concurrent same-key replays serialize and no-op.
  if exists (select 1 from public.inventory_ledger
             where shop_id = p_shop_id and idempotency_key = p_idempotency_key) then
    return;
  end if;
  update public.inventory_balance set on_hand = on_hand + p_qty, version = version + 1, updated_at = now()
    where shop_id = p_shop_id and variant_id = p_variant_id and location_id = p_location_id;
  insert into public.inventory_ledger (shop_id, variant_id, location_id, entry_type, qty, idempotency_key, reason, source)
    values (p_shop_id, p_variant_id, p_location_id, 'restock', p_qty, p_idempotency_key, p_reason, 'merchant');
end $$;
