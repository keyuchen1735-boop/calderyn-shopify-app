-- Harden inventory_adjust so a merchant absolute-set of on_hand can never corrupt the ledger
-- invariant on_hand >= reserved + unavailable (i.e. available = on_hand - reserved - unavailable >= 0).
--
-- Two related defects the old `greatest(p_new_on_hand, 0)` floor allowed:
--   1) NEGATIVE on_hand on commit. Set on_hand below `reserved` (units already held for a sale),
--      then inventory_commit does on_hand := on_hand - qty, reserved := reserved - qty. With
--      on_hand < reserved the commit drives on_hand negative — a physically impossible stock count.
--   2) NEGATIVE available. Mark N units damaged (unavailable += N) then set on_hand below N: the
--      generated `available` column (on_hand - reserved - unavailable) goes negative, the panel shows
--      a red negative Available, and there was no UI path to reduce `unavailable` to recover.
--
-- Fix, atomically under the existing FOR UPDATE lock:
--   * Floor on_hand at `reserved` — a merchant can't record fewer physical units than are already
--     spoken-for by an open reservation (which would let a later commit go negative). Held
--     reservations are transient (30-min TTL, released by the reaper), so the merchant can set the
--     lower count once they clear.
--   * Reconcile the `unavailable` (damaged) bucket to what physically remains after reserved
--     (`least(unavailable, on_hand - reserved)`). Lowering on_hand (e.g. discarding damaged units)
--     now trims the damaged bucket in step, so available stays >= 0 with no separate un-damage step.
-- Both column changes are journaled in the same transaction (the ledger stays a faithful replay of
-- every balance change). The common paths (seed, and any set where on_hand >= reserved + unavailable)
-- are unchanged — only the previously-corrupting edge cases behave differently.

create or replace function public.inventory_adjust(
  p_shop_id uuid, p_variant_id uuid, p_location_id uuid, p_new_on_hand int, p_reason text
) returns void language plpgsql set search_path = '' as $$
declare
  prev int; v_reserved int; v_unavail int;
  v_new int; v_new_unavail int; v_delta int; v_unavail_restored int;
begin
  insert into public.inventory_balance (shop_id, variant_id, location_id, on_hand, version, updated_at)
    values (p_shop_id, p_variant_id, p_location_id, 0, 0, now())
    on conflict (variant_id, location_id) do nothing;
  select on_hand, reserved, unavailable into prev, v_reserved, v_unavail
    from public.inventory_balance
    where shop_id = p_shop_id and variant_id = p_variant_id and location_id = p_location_id
    for update;

  -- Never below what's reserved (else a later commit drives on_hand negative).
  v_new := greatest(p_new_on_hand, v_reserved);
  -- Damaged units can't exceed what physically remains after the reserved units.
  v_new_unavail := least(v_unavail, greatest(v_new - v_reserved, 0));
  v_delta := v_new - prev;
  v_unavail_restored := v_unavail - v_new_unavail; -- >= 0: units auto-returned to sellable, if any

  update public.inventory_balance
    set on_hand = v_new, unavailable = v_new_unavail, version = version + 1, updated_at = now()
    where shop_id = p_shop_id and variant_id = p_variant_id and location_id = p_location_id;

  insert into public.inventory_ledger (shop_id, variant_id, location_id, entry_type, qty, idempotency_key, reason, source)
    values (p_shop_id, p_variant_id, p_location_id, 'adjust', v_delta,
            'adjust:' || p_variant_id::text || ':' || p_location_id::text || ':' || gen_random_uuid()::text, p_reason, 'merchant');

  -- Journal the auto-reconciliation of the damaged bucket (sellable delta is positive: units
  -- returned to sellable), matching mark_unavailable's convention (qty = change in sellable).
  if v_unavail_restored > 0 then
    insert into public.inventory_ledger (shop_id, variant_id, location_id, entry_type, qty, idempotency_key, reason, source)
      values (p_shop_id, p_variant_id, p_location_id, 'mark_unavailable', v_unavail_restored,
              'adjunavail:' || p_variant_id::text || ':' || p_location_id::text || ':' || gen_random_uuid()::text,
              coalesce(p_reason, 'adjust_reconcile'), 'merchant');
  end if;
end $$;
