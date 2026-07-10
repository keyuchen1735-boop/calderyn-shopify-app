-- Reliability follow-up for the purchase-order subsystem. The original
-- purchase-order migration is already deployed; keep this migration safe to
-- apply after it by replacing functions and adding the advisor-recommended
-- foreign-key indexes only.

create index if not exists purchase_order_supplier_id_idx
  on public.purchase_order (supplier_id);
create index if not exists purchase_order_destination_location_id_idx
  on public.purchase_order (destination_location_id);
create index if not exists purchase_order_line_po_id_idx
  on public.purchase_order_line (po_id);
create index if not exists purchase_order_line_variant_id_idx
  on public.purchase_order_line (variant_id);

-- Serialize recomputations for one balance row. Without the explicit row lock,
-- two concurrent recompute-from-truth calls can both calculate against
-- different in-flight PO states and let the later UPDATE overwrite the newer
-- incoming total.
create or replace function public.po_recompute_incoming(
  p_shop_id uuid, p_variant_id uuid, p_location_id uuid
) returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.inventory_balance (shop_id, variant_id, location_id, version, updated_at)
    values (p_shop_id, p_variant_id, p_location_id, 1, now())
    on conflict (variant_id, location_id) do nothing;

  perform 1
    from public.inventory_balance b
   where b.shop_id = p_shop_id and b.variant_id = p_variant_id
     and b.location_id = p_location_id
   for update;

  update public.inventory_balance b
     set incoming = coalesce((
           select sum(t.qty) from public.inventory_transfer t
            where t.shop_id = p_shop_id and t.variant_id = p_variant_id
              and t.to_location_id = p_location_id and t.state = 'in_transit'
         ), 0) + coalesce((
           select sum(l.qty_ordered - l.qty_received)
             from public.purchase_order_line l
             join public.purchase_order po on po.id = l.po_id
            where l.shop_id = p_shop_id and l.variant_id = p_variant_id
              and po.destination_location_id = p_location_id
              and po.status in ('ordered','partial')
         ), 0),
         version = b.version + 1,
         updated_at = now()
   where b.shop_id = p_shop_id and b.variant_id = p_variant_id
     and b.location_id = p_location_id;
end $$;

-- An ordered PO is a successful retry of mark-ordered. Return every affected
-- variant and repair incoming so the app can retry inventory-level projection
-- after a database commit followed by a projection failure.
create or replace function public.po_mark_ordered(
  p_shop_id uuid, p_po_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare po record; ln record; v_variant uuid;
        v_variant_ids uuid[] := '{}'; v_variants jsonb := '[]'::jsonb;
begin
  select * into po from public.purchase_order
    where id = p_po_id and shop_id = p_shop_id for update;
  if not found then raise exception 'po_not_found' using errcode = 'P0001'; end if;
  if po.status not in ('draft','ordered') then
    raise exception 'po_not_draft' using errcode = 'P0001';
  end if;

  if po.status = 'draft' then
    perform 1 from public.location_dim
      where id = po.destination_location_id and shop_id = p_shop_id
        and coalesce(active, true);
    if not found then raise exception 'location_inactive' using errcode = 'P0001'; end if;
    perform 1 from public.purchase_order_line where po_id = p_po_id and shop_id = p_shop_id;
    if not found then raise exception 'po_empty' using errcode = 'P0001'; end if;
  end if;

  for ln in
    select * from public.purchase_order_line
      where po_id = p_po_id and shop_id = p_shop_id
  loop
    if ln.variant_id is null then
      if po.status = 'draft' then
        raise exception 'line_variant_missing' using errcode = 'P0001';
      end if;
      continue;
    end if;
    if array_position(v_variant_ids, ln.variant_id) is null then
      v_variant_ids := v_variant_ids || ln.variant_id;
      v_variants := v_variants || to_jsonb(ln.variant_id::text);
    end if;
    if po.status = 'draft' then
      insert into public.inventory_ledger
          (shop_id, variant_id, location_id, entry_type, qty, order_ref,
           idempotency_key, reason, source)
        values
          (p_shop_id, ln.variant_id, po.destination_location_id, 'in_transit',
           ln.qty_ordered, po.po_number, 'po_order:' || ln.id::text,
           'po_ordered', 'merchant');
    end if;
  end loop;

  if po.status = 'draft' then
    update public.purchase_order
       set status = 'ordered', ordered_at = now(), updated_at = now()
     where id = p_po_id;
  end if;
  for v_variant in
    select id from unnest(v_variant_ids) as variants(id) order by id
  loop
    perform public.po_recompute_incoming(
      p_shop_id, v_variant, po.destination_location_id);
  end loop;
  return jsonb_build_object(
    'variantIds', v_variants, 'locationId', po.destination_location_id);
end $$;

-- A receipt-id replay remains successful even after the original submission
-- fully received the PO. Existing ledger keys identify the exact committed
-- lines; those variants are returned and recomputed so projection recovery is
-- possible without applying stock twice.
create or replace function public.po_receive(
  p_shop_id uuid, p_po_id uuid, p_lines jsonb, p_receipt_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare po record; entry record; ln record; v_new_total int; v_open int;
        v_existing_qty int; v_existing_count int := 0;
        v_key text; v_variant uuid; v_applied boolean := false;
        v_is_replay boolean := false;
        v_variant_ids uuid[] := '{}'; v_variants jsonb := '[]'::jsonb;
begin
  select * into po from public.purchase_order
    where id = p_po_id and shop_id = p_shop_id for update;
  if not found then raise exception 'po_not_found' using errcode = 'P0001'; end if;
  if p_receipt_id is null then
    raise exception 'invalid_receipt_id' using errcode = 'P0001';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array'
     or jsonb_array_length(p_lines) = 0 then
    raise exception 'invalid_receive_qty' using errcode = 'P0001';
  end if;
  if po.status not in ('ordered','partial','received') then
    raise exception 'po_not_receivable' using errcode = 'P0001';
  end if;

  -- A receipt id identifies the whole request, not independent per-line
  -- mutations. Once any key for it exists, the submitted line/qty set must
  -- exactly match every committed key; a superset must use a new receipt id.
  -- The transaction advisory lock closes the concurrent first-use race across
  -- different POs in the same shop.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_shop_id::text || ':' || p_receipt_id::text, 0));
  select count(*) into v_existing_count
    from public.inventory_ledger existing
   where existing.shop_id = p_shop_id
     and existing.idempotency_key like
       'po_receive:' || p_receipt_id::text || ':%';
  if v_existing_count > 0 then
    if v_existing_count <> jsonb_array_length(p_lines) then
      raise exception 'receipt_conflict' using errcode = 'P0001';
    end if;
    perform 1
      from public.inventory_ledger existing
     where existing.shop_id = p_shop_id
       and existing.idempotency_key like
         'po_receive:' || p_receipt_id::text || ':%'
       and not exists (
         select 1
           from jsonb_array_elements(p_lines) submitted
          where existing.idempotency_key =
                  'po_receive:' || p_receipt_id::text || ':' ||
                  (submitted ->> 'line_id')
            and existing.qty = (submitted ->> 'qty')::int
       );
    if found then
      raise exception 'receipt_conflict' using errcode = 'P0001';
    end if;
    v_is_replay := true;
  end if;

  if po.status <> 'received' and not v_is_replay then
    perform 1 from public.location_dim
      where id = po.destination_location_id and shop_id = p_shop_id
        and coalesce(active, true);
    if not found then raise exception 'location_inactive' using errcode = 'P0001'; end if;
  end if;

  for entry in
    select parsed.line_id, parsed.qty
      from (
        select (e ->> 'line_id')::uuid as line_id,
               (e ->> 'qty')::int as qty
          from jsonb_array_elements(p_lines) e
      ) parsed
      left join public.purchase_order_line sort_line
        on sort_line.id = parsed.line_id and sort_line.po_id = p_po_id
       and sort_line.shop_id = p_shop_id
     order by sort_line.variant_id nulls last, parsed.line_id
  loop
    if entry.qty is null or entry.qty <= 0 then
      raise exception 'invalid_receive_qty' using errcode = 'P0001';
    end if;
    select * into ln from public.purchase_order_line
      where id = entry.line_id and po_id = p_po_id and shop_id = p_shop_id
      for update;
    if not found then raise exception 'line_not_found' using errcode = 'P0001'; end if;
    if ln.variant_id is null then
      raise exception 'line_variant_missing' using errcode = 'P0001';
    end if;
    v_key := 'po_receive:' || p_receipt_id::text || ':' || ln.id::text;
    select qty into v_existing_qty from public.inventory_ledger
      where shop_id = p_shop_id and idempotency_key = v_key;
    if found then
      if v_existing_qty <> entry.qty then
        raise exception 'receipt_conflict' using errcode = 'P0001';
      end if;
      if array_position(v_variant_ids, ln.variant_id) is null then
        v_variant_ids := v_variant_ids || ln.variant_id;
        v_variants := v_variants || to_jsonb(ln.variant_id::text);
      end if;
      continue;
    end if;
    -- Once fully received, only exact receipt-ledger replays are accepted.
    if po.status = 'received' then
      raise exception 'po_not_receivable' using errcode = 'P0001';
    end if;
    v_new_total := ln.qty_received + entry.qty;
    if v_new_total > ln.qty_ordered then
      raise exception 'receive_exceeds_ordered' using errcode = 'P0001';
    end if;

    insert into public.inventory_balance
        (shop_id, variant_id, location_id, on_hand, version, updated_at)
      values
        (p_shop_id, ln.variant_id, po.destination_location_id,
         entry.qty, 1, now())
      on conflict (variant_id, location_id) do update
        set on_hand = public.inventory_balance.on_hand + entry.qty,
            version = public.inventory_balance.version + 1,
            updated_at = now();
    insert into public.inventory_ledger
        (shop_id, variant_id, location_id, entry_type, qty, order_ref,
         idempotency_key, reason, source)
      values
        (p_shop_id, ln.variant_id, po.destination_location_id, 'receive',
         entry.qty, po.po_number, v_key, 'po_received', 'merchant');
    update public.purchase_order_line
       set qty_received = v_new_total
     where id = ln.id;
    v_applied := true;
    if array_position(v_variant_ids, ln.variant_id) is null then
      v_variant_ids := v_variant_ids || ln.variant_id;
      v_variants := v_variants || to_jsonb(ln.variant_id::text);
    end if;
  end loop;

  select count(*) into v_open from public.purchase_order_line
    where po_id = p_po_id and shop_id = p_shop_id
      and qty_received < qty_ordered;
  if v_applied then
    if v_open = 0 then
      update public.purchase_order
         set status = 'received', received_at = now(), updated_at = now()
       where id = p_po_id;
    else
      update public.purchase_order
         set status = 'partial', updated_at = now()
       where id = p_po_id;
    end if;
  end if;
  for v_variant in
    select id from unnest(v_variant_ids) as variants(id) order by id
  loop
    perform public.po_recompute_incoming(
      p_shop_id, v_variant, po.destination_location_id);
  end loop;
  return jsonb_build_object(
    'variantIds', v_variants,
    'locationId', po.destination_location_id,
    'status', case when v_open = 0 then 'received' else 'partial' end);
end $$;

-- A cancelled PO is a successful retry. Recompute and return all surviving
-- variants so a post-commit projection failure can be repaired safely.
create or replace function public.po_cancel(
  p_shop_id uuid, p_po_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare po record; ln record; v_remaining int; v_variant uuid;
        v_variant_ids uuid[] := '{}'; v_variants jsonb := '[]'::jsonb;
begin
  select * into po from public.purchase_order
    where id = p_po_id and shop_id = p_shop_id for update;
  if not found then raise exception 'po_not_found' using errcode = 'P0001'; end if;
  if po.status not in ('draft','ordered','partial','cancelled') then
    raise exception 'po_not_cancellable' using errcode = 'P0001';
  end if;

  for ln in
    select * from public.purchase_order_line
      where po_id = p_po_id and shop_id = p_shop_id
  loop
    if ln.variant_id is null then continue; end if;
    if array_position(v_variant_ids, ln.variant_id) is null then
      v_variant_ids := v_variant_ids || ln.variant_id;
      v_variants := v_variants || to_jsonb(ln.variant_id::text);
    end if;
    if po.status in ('ordered','partial') then
      v_remaining := ln.qty_ordered - ln.qty_received;
      if v_remaining > 0 then
        insert into public.inventory_ledger
            (shop_id, variant_id, location_id, entry_type, qty, order_ref,
             idempotency_key, reason, source)
          values
            (p_shop_id, ln.variant_id, po.destination_location_id,
             'in_transit', -v_remaining, po.po_number,
             'po_cancel:' || ln.id::text, 'po_cancelled', 'merchant');
      end if;
    end if;
  end loop;

  if po.status <> 'cancelled' then
    update public.purchase_order
       set status = 'cancelled', cancelled_at = now(), updated_at = now()
     where id = p_po_id;
  end if;
  for v_variant in
    select id from unnest(v_variant_ids) as variants(id) order by id
  loop
    perform public.po_recompute_incoming(
      p_shop_id, v_variant, po.destination_location_id);
  end loop;
  return jsonb_build_object(
    'variantIds', v_variants, 'locationId', po.destination_location_id);
end $$;
