-- Atomic multi-location hold. Runs in its own transaction; FOR UPDATE locks each
-- balance row; raises to roll back ALL holds if the order can't be covered.
-- This is the warehouse's first mutable concurrent write path: the hold/decrement
-- MUST be a single FOR UPDATE + recheck, never read-then-write, or it oversells.
--
-- One checkout_ref spans every line item of a cart (commit/release settle the whole
-- order by checkout_ref), so the replay guard and every idempotency key are scoped
-- by variant_id -- otherwise the 2nd+ line item of a cart silently returns the 1st
-- line's allocation without holding anything (oversell), or collides on the unique
-- key. A concurrent duplicate submit of the same (checkout, variant) loses the
-- unique-key race and is caught below, returning the winner's allocation.
create or replace function public.inventory_reserve(
  p_shop_id uuid, p_variant_id uuid, p_qty int, p_location_ids uuid[],
  p_checkout_ref text, p_expires_at timestamptz, p_idempotency_key text, p_allow_backorder boolean
) returns jsonb language plpgsql set search_path = '' as $$
declare remaining int := p_qty; loc uuid; avail int; take int; bo_loc uuid; alloc jsonb := '[]'::jsonb;
begin
  -- Idempotent replay: existing holds for this (checkout, variant) -> return them unchanged.
  if exists (select 1 from public.inventory_reservation where shop_id = p_shop_id and checkout_ref = p_checkout_ref and variant_id = p_variant_id and state = 'held') then
    select coalesce(jsonb_agg(jsonb_build_object('locationId', location_id, 'qty', qty)), '[]'::jsonb)
      into alloc from public.inventory_reservation where shop_id = p_shop_id and checkout_ref = p_checkout_ref and variant_id = p_variant_id and state = 'held';
    return jsonb_build_object('ok', true, 'allocation', alloc);
  end if;

  foreach loc in array p_location_ids loop
    exit when remaining <= 0;
    select (on_hand - reserved - unavailable) into avail
      from public.inventory_balance
      where shop_id = p_shop_id and variant_id = p_variant_id and location_id = loc
      for update;
    if not found or avail is null or avail <= 0 then continue; end if;
    take := least(remaining, avail);
    update public.inventory_balance set reserved = reserved + take, version = version + 1, updated_at = now()
      where shop_id = p_shop_id and variant_id = p_variant_id and location_id = loc;
    insert into public.inventory_reservation (shop_id, variant_id, location_id, qty, state, checkout_ref, expires_at, idempotency_key)
      values (p_shop_id, p_variant_id, loc, take, 'held', p_checkout_ref, p_expires_at, p_idempotency_key || ':' || p_variant_id::text || ':' || loc::text);
    insert into public.inventory_ledger (shop_id, variant_id, location_id, entry_type, qty, order_ref, idempotency_key, source)
      values (p_shop_id, p_variant_id, loc, 'reserve', -take, p_checkout_ref, p_idempotency_key || ':reserve:' || p_variant_id::text || ':' || loc::text, 'checkout');
    alloc := alloc || jsonb_build_array(jsonb_build_object('locationId', loc, 'qty', take));
    remaining := remaining - take;
  end loop;

  if remaining > 0 then
    if not p_allow_backorder then
      raise exception 'insufficient_stock' using errcode = 'P0001';
    end if;
    -- Backorder ('continue' policy): hold the SHORTFALL at the primary location,
    -- driving available negative so (a) the owed units are tracked and (b) the
    -- returned allocation sums to the FULL requested qty -- checkout must never
    -- think more was reserved than actually was. Upsert the primary row so a
    -- missing balance row can't silently no-op the reserved bump.
    bo_loc := p_location_ids[1];
    insert into public.inventory_balance (shop_id, variant_id, location_id, reserved, version, updated_at)
      values (p_shop_id, p_variant_id, bo_loc, remaining, 1, now())
      on conflict (variant_id, location_id) do update
        set reserved = public.inventory_balance.reserved + remaining, version = public.inventory_balance.version + 1, updated_at = now();
    insert into public.inventory_reservation (shop_id, variant_id, location_id, qty, state, checkout_ref, expires_at, idempotency_key)
      values (p_shop_id, p_variant_id, bo_loc, remaining, 'held', p_checkout_ref, p_expires_at, p_idempotency_key || ':bo:' || p_variant_id::text || ':' || bo_loc::text);
    insert into public.inventory_ledger (shop_id, variant_id, location_id, entry_type, qty, order_ref, idempotency_key, source)
      values (p_shop_id, p_variant_id, bo_loc, 'reserve', -remaining, p_checkout_ref, p_idempotency_key || ':reserve:bo:' || p_variant_id::text || ':' || bo_loc::text, 'checkout');
    alloc := alloc || jsonb_build_array(jsonb_build_object('locationId', bo_loc, 'qty', remaining, 'backorder', true));
    remaining := 0;
  end if;
  return jsonb_build_object('ok', true, 'allocation', alloc);

exception when unique_violation then
  -- A concurrent reserve for the same (checkout, variant) won the unique-key race;
  -- our partial work is rolled back to the function's start. Return the winner's
  -- held allocation so a duplicate submit is idempotent, not a 500.
  select coalesce(jsonb_agg(jsonb_build_object('locationId', location_id, 'qty', qty)), '[]'::jsonb)
    into alloc from public.inventory_reservation where shop_id = p_shop_id and checkout_ref = p_checkout_ref and variant_id = p_variant_id and state = 'held';
  return jsonb_build_object('ok', true, 'allocation', alloc);
end $$;

-- Payment: turn holds into real decrements. The held->committed transition and the
-- balance decrement are ONE atomic statement: only the transaction that actually
-- flips a reservation 'held'->'committed' (RETURNING it) decrements the balance, so
-- a concurrent commit/release (webhook retry racing the reaper) cannot double-apply.
-- Idempotent on checkout_ref. Aggregates by (variant, location) so a checkout that
-- holds twice at one location (backorder primary) decrements exactly once.
create or replace function public.inventory_commit(p_shop_id uuid, p_checkout_ref text)
returns void language plpgsql set search_path = '' as $$
begin
  with claimed as (
    update public.inventory_reservation
       set state = 'committed'
     where shop_id = p_shop_id and checkout_ref = p_checkout_ref and state = 'held'
     returning id, variant_id, location_id, qty
  ),
  agg as (
    select variant_id, location_id, sum(qty) as qty from claimed group by variant_id, location_id
  ),
  bal as (
    update public.inventory_balance b
       set on_hand = b.on_hand - a.qty, reserved = b.reserved - a.qty, version = b.version + 1, updated_at = now()
      from agg a
     where b.shop_id = p_shop_id and b.variant_id = a.variant_id and b.location_id = a.location_id
     returning 1
  )
  insert into public.inventory_ledger (shop_id, variant_id, location_id, entry_type, qty, reservation_id, order_ref, idempotency_key, source)
  select p_shop_id, c.variant_id, c.location_id, 'sale', -c.qty, c.id, p_checkout_ref, 'commit:' || c.id::text, 'checkout'
    from claimed c
  on conflict (shop_id, idempotency_key) do nothing;
end $$;

-- Abandon/expiry: free holds. Same atomic held->released transition as commit;
-- only the transaction that flips a hold frees its reserved units. Idempotent.
create or replace function public.inventory_release(p_shop_id uuid, p_checkout_ref text)
returns void language plpgsql set search_path = '' as $$
begin
  with claimed as (
    update public.inventory_reservation
       set state = 'released'
     where shop_id = p_shop_id and checkout_ref = p_checkout_ref and state = 'held'
     returning id, variant_id, location_id, qty
  ),
  agg as (
    select variant_id, location_id, sum(qty) as qty from claimed group by variant_id, location_id
  ),
  bal as (
    update public.inventory_balance b
       set reserved = b.reserved - a.qty, version = b.version + 1, updated_at = now()
      from agg a
     where b.shop_id = p_shop_id and b.variant_id = a.variant_id and b.location_id = a.location_id
     returning 1
  )
  insert into public.inventory_ledger (shop_id, variant_id, location_id, entry_type, qty, reservation_id, order_ref, idempotency_key, source)
  select p_shop_id, c.variant_id, c.location_id, 'release', c.qty, c.id, p_checkout_ref, 'release:' || c.id::text, 'system'
    from claimed c
  on conflict (shop_id, idempotency_key) do nothing;
end $$;
