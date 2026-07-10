-- Purchase-order subsystem: merchant-facing suppliers + real purchase orders
-- with a draft → ordered → partial → received lifecycle (plus cancelled).
-- Ordering a PO moves its quantities into inventory_balance.incoming; receiving
-- moves incoming → on_hand — both through atomic SQL functions in the style of
-- 20260629160150_inventory_merchant_fns.sql (FOR UPDATE lock + relative writes
-- + an inventory_ledger row in the same transaction). New tables are keyed by
-- internal shop_id and get RLS enabled with no policies (service-role only),
-- matching 20260629160000_inventory_tables.sql. The legacy engine table
-- purchase_order_draft and the global supplier table are untouched.

-- ---- supplier_dim -----------------------------------------------------------

create table if not exists public.supplier_dim (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  name text not null,
  email text,
  phone text,
  notes text,
  lead_time_days int check (lead_time_days >= 0 and lead_time_days <= 365),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Unique per shop on the lowercased name so "Acme" and "acme" can't coexist.
create unique index if not exists supplier_dim_shop_name_key
  on public.supplier_dim (shop_id, lower(name));
alter table public.supplier_dim enable row level security;

-- ---- purchase_order ---------------------------------------------------------

create table if not exists public.purchase_order (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  po_number text not null,
  supplier_id uuid references public.supplier_dim(id),
  -- Supplier name snapshotted at create/update so later renames or deletions
  -- never rewrite the history of an issued PO.
  vendor_name text,
  destination_location_id uuid not null references public.location_dim(id),
  status text not null default 'draft'
    check (status in ('draft','ordered','partial','received','cancelled')),
  expected_at date,
  notes text,
  source text not null default 'manual' check (source in ('manual','autopilot')),
  -- Links a promoted Autopilot draft back to its action_audit row; also hides
  -- already-promoted drafts from the drafts list.
  audit_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ordered_at timestamptz,
  received_at timestamptz,
  cancelled_at timestamptz,
  unique (shop_id, po_number)
);
create index if not exists purchase_order_shop_idx
  on public.purchase_order (shop_id, created_at desc);
-- One real PO per Autopilot draft: blocks double promotion at the database.
create unique index if not exists purchase_order_audit_id_key
  on public.purchase_order (audit_id) where audit_id is not null;
alter table public.purchase_order enable row level security;

-- ---- purchase_order_line ----------------------------------------------------

create table if not exists public.purchase_order_line (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  po_id uuid not null references public.purchase_order(id) on delete cascade,
  variant_id uuid not null references public.variant_dim(id),
  qty_ordered int not null check (qty_ordered > 0 and qty_ordered <= 1000000),
  qty_received int not null default 0 check (qty_received >= 0),
  -- null = unit cost unknown ("TBD"), same convention as the PoDraft snapshot.
  unit_cost_cents int check (unit_cost_cents >= 0),
  unique (po_id, variant_id)
);
create index if not exists purchase_order_line_shop_po_idx
  on public.purchase_order_line (shop_id, po_id);
alter table public.purchase_order_line enable row level security;

-- ---- po_mark_ordered --------------------------------------------------------
-- draft → ordered. Requires at least one line and an ACTIVE destination (the
-- relocate guard — a deactivated location must not silently start accumulating
-- expected stock). Per line: destination incoming += qty_ordered plus an
-- 'in_transit' ledger row keyed po_order:<line_id>. Returns the touched
-- variant ids + destination so the app layer re-projects inventory_level_fact.

create or replace function public.po_mark_ordered(
  p_shop_id uuid, p_po_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare po record; ln record; v_variants jsonb := '[]'::jsonb;
begin
  select * into po from public.purchase_order
    where id = p_po_id and shop_id = p_shop_id for update;
  if not found then raise exception 'po_not_found' using errcode = 'P0001'; end if;
  if po.status <> 'draft' then raise exception 'po_not_draft' using errcode = 'P0001'; end if;
  perform 1 from public.location_dim
    where id = po.destination_location_id and shop_id = p_shop_id and active;
  if not found then raise exception 'location_inactive' using errcode = 'P0001'; end if;
  perform 1 from public.purchase_order_line where po_id = p_po_id and shop_id = p_shop_id;
  if not found then raise exception 'po_empty' using errcode = 'P0001'; end if;

  for ln in
    select * from public.purchase_order_line
      where po_id = p_po_id and shop_id = p_shop_id
  loop
    insert into public.inventory_balance (shop_id, variant_id, location_id, incoming, version, updated_at)
      values (p_shop_id, ln.variant_id, po.destination_location_id, ln.qty_ordered, 1, now())
      on conflict (variant_id, location_id) do update
        set incoming = public.inventory_balance.incoming + ln.qty_ordered,
            version = public.inventory_balance.version + 1,
            updated_at = now();
    insert into public.inventory_ledger (shop_id, variant_id, location_id, entry_type, qty, order_ref, idempotency_key, reason, source)
      values (p_shop_id, ln.variant_id, po.destination_location_id, 'in_transit', ln.qty_ordered,
              po.po_number, 'po_order:' || ln.id::text, 'po_ordered', 'merchant');
    v_variants := v_variants || to_jsonb(ln.variant_id::text);
  end loop;

  update public.purchase_order
     set status = 'ordered', ordered_at = now(), updated_at = now()
   where id = p_po_id;
  return jsonb_build_object('variantIds', v_variants, 'locationId', po.destination_location_id);
end $$;

-- ---- po_receive -------------------------------------------------------------
-- ordered/partial → partial/received. p_lines = [{line_id, qty}]. Per entry the
-- line row is locked, qty_received + qty must not exceed qty_ordered, and the
-- destination balance moves incoming → on_hand (incoming clamped at 0, so other
-- outstanding expectations at the same destination stay correct). Ledger
-- 'receive' rows are keyed po_receive:<line_id>:<new_total>, so a replayed call
-- with the same quantities collides on the idempotency key instead of double-
-- counting. Status becomes 'received' (+ received_at) when every line is fully
-- received, else 'partial'. Returns touched variant ids + destination.

create or replace function public.po_receive(
  p_shop_id uuid, p_po_id uuid, p_lines jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare po record; entry record; ln record; v_new_total int; v_open int;
        v_variants jsonb := '[]'::jsonb;
begin
  select * into po from public.purchase_order
    where id = p_po_id and shop_id = p_shop_id for update;
  if not found then raise exception 'po_not_found' using errcode = 'P0001'; end if;
  if po.status not in ('ordered','partial') then
    raise exception 'po_not_receivable' using errcode = 'P0001';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'invalid_receive_qty' using errcode = 'P0001';
  end if;

  for entry in
    select (e ->> 'line_id')::uuid as line_id, (e ->> 'qty')::int as qty
      from jsonb_array_elements(p_lines) e
  loop
    if entry.qty is null or entry.qty <= 0 then
      raise exception 'invalid_receive_qty' using errcode = 'P0001';
    end if;
    select * into ln from public.purchase_order_line
      where id = entry.line_id and po_id = p_po_id and shop_id = p_shop_id for update;
    if not found then raise exception 'line_not_found' using errcode = 'P0001'; end if;
    v_new_total := ln.qty_received + entry.qty;
    if v_new_total > ln.qty_ordered then
      raise exception 'receive_exceeds_ordered' using errcode = 'P0001';
    end if;

    insert into public.inventory_balance (shop_id, variant_id, location_id, on_hand, version, updated_at)
      values (p_shop_id, ln.variant_id, po.destination_location_id, entry.qty, 1, now())
      on conflict (variant_id, location_id) do update
        set incoming = greatest(public.inventory_balance.incoming - entry.qty, 0),
            on_hand = public.inventory_balance.on_hand + entry.qty,
            version = public.inventory_balance.version + 1,
            updated_at = now();
    insert into public.inventory_ledger (shop_id, variant_id, location_id, entry_type, qty, order_ref, idempotency_key, reason, source)
      values (p_shop_id, ln.variant_id, po.destination_location_id, 'receive', entry.qty,
              po.po_number, 'po_receive:' || ln.id::text || ':' || v_new_total::text, 'po_received', 'merchant');
    update public.purchase_order_line set qty_received = v_new_total where id = ln.id;
    v_variants := v_variants || to_jsonb(ln.variant_id::text);
  end loop;

  select count(*) into v_open from public.purchase_order_line
    where po_id = p_po_id and shop_id = p_shop_id and qty_received < qty_ordered;
  if v_open = 0 then
    update public.purchase_order
       set status = 'received', received_at = now(), updated_at = now()
     where id = p_po_id;
  else
    update public.purchase_order set status = 'partial', updated_at = now() where id = p_po_id;
  end if;
  return jsonb_build_object(
    'variantIds', v_variants,
    'locationId', po.destination_location_id,
    'status', case when v_open = 0 then 'received' else 'partial' end);
end $$;

-- ---- po_cancel --------------------------------------------------------------
-- draft/ordered/partial → cancelled. For ordered/partial the remaining
-- expectation (qty_ordered - qty_received) is removed from incoming per line,
-- journaled as a negative 'in_transit' row (keeps the incoming journal
-- balanced). Already-received stock stays. Returns touched variant ids +
-- destination (empty list for a draft — no balances were touched).

create or replace function public.po_cancel(
  p_shop_id uuid, p_po_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare po record; ln record; v_remaining int; v_variants jsonb := '[]'::jsonb;
begin
  select * into po from public.purchase_order
    where id = p_po_id and shop_id = p_shop_id for update;
  if not found then raise exception 'po_not_found' using errcode = 'P0001'; end if;
  if po.status not in ('draft','ordered','partial') then
    raise exception 'po_not_cancellable' using errcode = 'P0001';
  end if;

  if po.status in ('ordered','partial') then
    for ln in
      select * from public.purchase_order_line
        where po_id = p_po_id and shop_id = p_shop_id
    loop
      v_remaining := ln.qty_ordered - ln.qty_received;
      if v_remaining > 0 then
        update public.inventory_balance
           set incoming = greatest(incoming - v_remaining, 0),
               version = version + 1,
               updated_at = now()
         where shop_id = p_shop_id and variant_id = ln.variant_id
           and location_id = po.destination_location_id;
        insert into public.inventory_ledger (shop_id, variant_id, location_id, entry_type, qty, order_ref, idempotency_key, reason, source)
          values (p_shop_id, ln.variant_id, po.destination_location_id, 'in_transit', -v_remaining,
                  po.po_number, 'po_cancel:' || ln.id::text, 'po_cancelled', 'merchant');
        v_variants := v_variants || to_jsonb(ln.variant_id::text);
      end if;
    end loop;
  end if;

  update public.purchase_order
     set status = 'cancelled', cancelled_at = now(), updated_at = now()
   where id = p_po_id;
  return jsonb_build_object('variantIds', v_variants, 'locationId', po.destination_location_id);
end $$;

-- ---- grants -----------------------------------------------------------------
-- security definer functions must not be callable by anon/authenticated; the
-- app always goes through the service role. Revoking from PUBLIC matters —
-- revoking only from anon leaves the default PUBLIC execute grant in place.

revoke all on function public.po_mark_ordered(uuid, uuid) from public, anon, authenticated;
revoke all on function public.po_receive(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.po_cancel(uuid, uuid) from public, anon, authenticated;
grant execute on function public.po_mark_ordered(uuid, uuid) to service_role;
grant execute on function public.po_receive(uuid, uuid, jsonb) to service_role;
grant execute on function public.po_cancel(uuid, uuid) to service_role;
