-- Merchant stock mutations as atomic SQL functions. These share the on_hand /
-- reserved / unavailable columns with the buyer reserve/commit path, so they MUST
-- be atomic (FOR UPDATE lock + relative write), not a read-then-absolute-write in
-- TS -- otherwise a merchant edit racing a buyer's commit loses the sale's
-- decrement (phantom restock -> oversell). Every write is shop-scoped and journals
-- an inventory_ledger row in the same transaction as the balance change.

-- Merchant sets an absolute count for a (variant, location). Locks the row, reads
-- the prior on_hand under the lock, writes the new value, journals the delta.
create or replace function public.inventory_adjust(
  p_shop_id uuid, p_variant_id uuid, p_location_id uuid, p_new_on_hand int, p_reason text
) returns void language plpgsql set search_path = '' as $$
declare prev int; v_new int := greatest(p_new_on_hand, 0); v_delta int;
begin
  insert into public.inventory_balance (shop_id, variant_id, location_id, on_hand, version, updated_at)
    values (p_shop_id, p_variant_id, p_location_id, 0, 0, now())
    on conflict (variant_id, location_id) do nothing;
  select on_hand into prev from public.inventory_balance
    where shop_id = p_shop_id and variant_id = p_variant_id and location_id = p_location_id
    for update;
  v_delta := v_new - prev;
  update public.inventory_balance set on_hand = v_new, version = version + 1, updated_at = now()
    where shop_id = p_shop_id and variant_id = p_variant_id and location_id = p_location_id;
  insert into public.inventory_ledger (shop_id, variant_id, location_id, entry_type, qty, idempotency_key, reason, source)
    values (p_shop_id, p_variant_id, p_location_id, 'adjust', v_delta,
            'adjust:' || p_variant_id::text || ':' || p_location_id::text || ':' || gen_random_uuid()::text, p_reason, 'merchant');
end $$;

-- Move qty from sellable into the unavailable bucket (damaged / safety stock).
-- Clamped: rejects if it would drive available negative. Relative bump so two
-- concurrent marks compose instead of clobbering.
create or replace function public.inventory_mark_unavailable(
  p_shop_id uuid, p_variant_id uuid, p_location_id uuid, p_qty int, p_reason text
) returns void language plpgsql set search_path = '' as $$
declare sellable int;
begin
  select (on_hand - reserved - unavailable) into sellable from public.inventory_balance
    where shop_id = p_shop_id and variant_id = p_variant_id and location_id = p_location_id
    for update;
  if not found then raise exception 'no_balance_row' using errcode = 'P0001'; end if;
  if sellable < p_qty then raise exception 'insufficient_available' using errcode = 'P0001'; end if;
  update public.inventory_balance set unavailable = unavailable + p_qty, version = version + 1, updated_at = now()
    where shop_id = p_shop_id and variant_id = p_variant_id and location_id = p_location_id;
  insert into public.inventory_ledger (shop_id, variant_id, location_id, entry_type, qty, idempotency_key, reason, source)
    values (p_shop_id, p_variant_id, p_location_id, 'mark_unavailable', -p_qty,
            'unavail:' || p_variant_id::text || ':' || p_location_id::text || ':' || gen_random_uuid()::text, p_reason, 'merchant');
end $$;

-- Move stock between two locations. Source decrement is an atomic conditional
-- write (lock + available recheck); destination bump is a relative upsert so it
-- composes with concurrent receives. Instant lands in on_hand; in-transit lands
-- in incoming (received later). Returns the new transfer id.
create or replace function public.inventory_create_transfer(
  p_shop_id uuid, p_variant_id uuid, p_from_location_id uuid, p_to_location_id uuid, p_qty int, p_mode text
) returns uuid language plpgsql set search_path = '' as $$
declare avail int; v_transfer_id uuid; v_state text := case when p_mode = 'instant' then 'received' else 'in_transit' end;
begin
  if p_from_location_id = p_to_location_id then raise exception 'same_location' using errcode = 'P0001'; end if;
  if p_qty < 1 then raise exception 'invalid_qty' using errcode = 'P0001'; end if;
  select (on_hand - reserved - unavailable) into avail from public.inventory_balance
    where shop_id = p_shop_id and variant_id = p_variant_id and location_id = p_from_location_id
    for update;
  if not found or avail < p_qty then raise exception 'insufficient_stock' using errcode = 'P0001'; end if;
  update public.inventory_balance set on_hand = on_hand - p_qty, version = version + 1, updated_at = now()
    where shop_id = p_shop_id and variant_id = p_variant_id and location_id = p_from_location_id;

  insert into public.inventory_transfer (shop_id, variant_id, from_location_id, to_location_id, qty, state, received_at)
    values (p_shop_id, p_variant_id, p_from_location_id, p_to_location_id, p_qty, v_state,
            case when p_mode = 'instant' then now() else null end)
    returning id into v_transfer_id;
  insert into public.inventory_ledger (shop_id, variant_id, location_id, entry_type, qty, transfer_id, idempotency_key, source)
    values (p_shop_id, p_variant_id, p_from_location_id, 'transfer_out', -p_qty, v_transfer_id, 'tout:' || v_transfer_id::text, 'merchant');

  if p_mode = 'instant' then
    insert into public.inventory_balance (shop_id, variant_id, location_id, on_hand, version, updated_at)
      values (p_shop_id, p_variant_id, p_to_location_id, p_qty, 1, now())
      on conflict (variant_id, location_id) do update
        set on_hand = public.inventory_balance.on_hand + p_qty, version = public.inventory_balance.version + 1, updated_at = now();
    insert into public.inventory_ledger (shop_id, variant_id, location_id, entry_type, qty, transfer_id, idempotency_key, source)
      values (p_shop_id, p_variant_id, p_to_location_id, 'transfer_in', p_qty, v_transfer_id, 'tin:' || v_transfer_id::text, 'merchant');
  else
    insert into public.inventory_balance (shop_id, variant_id, location_id, incoming, version, updated_at)
      values (p_shop_id, p_variant_id, p_to_location_id, p_qty, 1, now())
      on conflict (variant_id, location_id) do update
        set incoming = public.inventory_balance.incoming + p_qty, version = public.inventory_balance.version + 1, updated_at = now();
    insert into public.inventory_ledger (shop_id, variant_id, location_id, entry_type, qty, transfer_id, idempotency_key, source)
      values (p_shop_id, p_variant_id, p_to_location_id, 'in_transit', p_qty, v_transfer_id, 'tit:' || v_transfer_id::text, 'merchant');
  end if;
  return v_transfer_id;
end $$;

-- Receive an in-transit transfer at its destination. Shop-scoped and idempotent
-- (only an in_transit transfer receives). Decrements incoming by the transfer's
-- qty (clamped at 0, so multiple outstanding transfers to one destination are
-- correct) and adds to on_hand. Returns the (variant, destination) to re-project,
-- or null if it was already received / not this shop's.
create or replace function public.inventory_receive_transfer(
  p_shop_id uuid, p_transfer_id uuid
) returns jsonb language plpgsql set search_path = '' as $$
declare tr record;
begin
  select * into tr from public.inventory_transfer
    where id = p_transfer_id and shop_id = p_shop_id for update;
  if not found or tr.state <> 'in_transit' then return null; end if;
  update public.inventory_balance
     set incoming = greatest(incoming - tr.qty, 0), on_hand = on_hand + tr.qty, version = version + 1, updated_at = now()
   where shop_id = p_shop_id and variant_id = tr.variant_id and location_id = tr.to_location_id;
  update public.inventory_transfer set state = 'received', received_at = now() where id = p_transfer_id;
  insert into public.inventory_ledger (shop_id, variant_id, location_id, entry_type, qty, transfer_id, idempotency_key, source)
    values (p_shop_id, tr.variant_id, tr.to_location_id, 'received', tr.qty, p_transfer_id, 'recv:' || p_transfer_id::text, 'merchant');
  return jsonb_build_object('variantId', tr.variant_id, 'toLocationId', tr.to_location_id);
end $$;
