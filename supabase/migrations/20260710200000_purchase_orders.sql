-- Purchase-order subsystem: merchant-facing suppliers + real purchase orders
-- with a draft → ordered → partial → received lifecycle (plus cancelled).
-- Ordering a PO moves its quantities into inventory_balance.incoming; receiving
-- moves incoming → on_hand — both through atomic SQL functions in the style of
-- 20260629160150_inventory_merchant_fns.sql (FOR UPDATE lock + an
-- inventory_ledger row in the same transaction). inventory_balance.incoming is
-- never maintained as hand-written deltas: after every status/line change the
-- affected (variant, destination) pairs are recomputed from truth
-- (po_recompute_incoming) so drift cannot accumulate. New tables are keyed by
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
-- variant_id is nullable ON DELETE SET NULL: a variant that once appeared on a
-- PO must never block catalog deletion. The sku / variant_title snapshots are
-- filled at line creation so history stays readable after the variant is gone
-- (same convention as the PoDraft audit snapshots).

create table if not exists public.purchase_order_line (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  po_id uuid not null references public.purchase_order(id) on delete cascade,
  variant_id uuid references public.variant_dim(id) on delete set null,
  sku text,
  variant_title text,
  qty_ordered int not null check (qty_ordered > 0 and qty_ordered <= 1000000),
  qty_received int not null default 0 check (qty_received >= 0),
  -- null = unit cost unknown ("TBD"), same convention as the PoDraft snapshot.
  unit_cost_cents int check (unit_cost_cents >= 0),
  unique (po_id, variant_id)
);
create index if not exists purchase_order_line_shop_po_idx
  on public.purchase_order_line (shop_id, po_id);
alter table public.purchase_order_line enable row level security;

-- ---- po_recompute_incoming ---------------------------------------------------
-- Recompute-from-truth for inventory_balance.incoming at one (variant,
-- destination): open transfers in transit toward the location plus the
-- unreceived remainder of every ordered/partial PO destined for it. Called by
-- the po_* functions after their status/line changes, inside the same
-- transaction, so the balance can never drift from the journal the way
-- hand-written +/- deltas (with clamps silently absorbing errors) could.
-- Lines whose variant was deleted (variant_id null) are naturally excluded.

create or replace function public.po_recompute_incoming(
  p_shop_id uuid, p_variant_id uuid, p_location_id uuid
) returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.inventory_balance (shop_id, variant_id, location_id, version, updated_at)
    values (p_shop_id, p_variant_id, p_location_id, 1, now())
    on conflict (variant_id, location_id) do nothing;
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

-- ---- po_mark_ordered --------------------------------------------------------
-- draft → ordered. Requires at least one line and an ACTIVE destination (the
-- relocate guard — a deactivated location must not silently start accumulating
-- expected stock; a NULL active flag counts as active, matching
-- inventory_list). Per line: an 'in_transit' ledger row keyed
-- po_order:<line_id>. incoming is then recomputed from truth per variant.
-- Returns the touched variant ids + destination so the app layer re-projects
-- inventory_level_fact.

create or replace function public.po_mark_ordered(
  p_shop_id uuid, p_po_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare po record; ln record; v_variant uuid;
        v_variant_ids uuid[] := '{}'; v_variants jsonb := '[]'::jsonb;
begin
  select * into po from public.purchase_order
    where id = p_po_id and shop_id = p_shop_id for update;
  if not found then raise exception 'po_not_found' using errcode = 'P0001'; end if;
  if po.status <> 'draft' then raise exception 'po_not_draft' using errcode = 'P0001'; end if;
  perform 1 from public.location_dim
    where id = po.destination_location_id and shop_id = p_shop_id
      and coalesce(active, true);
  if not found then raise exception 'location_inactive' using errcode = 'P0001'; end if;
  perform 1 from public.purchase_order_line where po_id = p_po_id and shop_id = p_shop_id;
  if not found then raise exception 'po_empty' using errcode = 'P0001'; end if;

  for ln in
    select * from public.purchase_order_line
      where po_id = p_po_id and shop_id = p_shop_id
  loop
    -- A line whose variant was deleted can't be ordered (no balance to book).
    if ln.variant_id is null then
      raise exception 'line_variant_missing' using errcode = 'P0001';
    end if;
    insert into public.inventory_ledger (shop_id, variant_id, location_id, entry_type, qty, order_ref, idempotency_key, reason, source)
      values (p_shop_id, ln.variant_id, po.destination_location_id, 'in_transit', ln.qty_ordered,
              po.po_number, 'po_order:' || ln.id::text, 'po_ordered', 'merchant');
    v_variant_ids := v_variant_ids || ln.variant_id;
    v_variants := v_variants || to_jsonb(ln.variant_id::text);
  end loop;

  update public.purchase_order
     set status = 'ordered', ordered_at = now(), updated_at = now()
   where id = p_po_id;
  -- After the status flip so this PO's own remainder counts.
  foreach v_variant in array v_variant_ids loop
    perform public.po_recompute_incoming(p_shop_id, v_variant, po.destination_location_id);
  end loop;
  return jsonb_build_object('variantIds', v_variants, 'locationId', po.destination_location_id);
end $$;

-- ---- po_receive -------------------------------------------------------------
-- ordered/partial → partial/received. p_lines = [{line_id, qty}]. p_receipt_id
-- is a client-generated uuid, one per receive SUBMISSION (reused across
-- retries of that submission): ledger rows are keyed
-- po_receive:<receipt_id>:<line_id>, and any line whose key already exists is
-- skipped, so replaying an identical committed call is a true no-op instead of
-- double-counting on_hand. (A totals-based key would compute a NEW total on
-- replay and re-apply — that is exactly the bug this key shape avoids.)
-- Per entry the line row is locked and qty_received + qty must not exceed
-- qty_ordered; on_hand moves up by qty and incoming is recomputed from truth
-- afterwards. The destination must still be active (same guard as
-- po_mark_ordered — received stock at a deactivated location would be
-- invisible to the active-only inventory rollup). Status becomes 'received'
-- (+ received_at) when every line is fully received, else 'partial'. Returns
-- touched variant ids + destination.

create or replace function public.po_receive(
  p_shop_id uuid, p_po_id uuid, p_lines jsonb, p_receipt_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare po record; entry record; ln record; v_new_total int; v_open int;
        v_key text; v_variant uuid; v_variant_ids uuid[] := '{}';
        v_variants jsonb := '[]'::jsonb;
begin
  select * into po from public.purchase_order
    where id = p_po_id and shop_id = p_shop_id for update;
  if not found then raise exception 'po_not_found' using errcode = 'P0001'; end if;
  if po.status not in ('ordered','partial') then
    raise exception 'po_not_receivable' using errcode = 'P0001';
  end if;
  perform 1 from public.location_dim
    where id = po.destination_location_id and shop_id = p_shop_id
      and coalesce(active, true);
  if not found then raise exception 'location_inactive' using errcode = 'P0001'; end if;
  if p_receipt_id is null then
    raise exception 'invalid_receipt_id' using errcode = 'P0001';
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
    -- Stock can't be received for a variant that no longer exists.
    if ln.variant_id is null then
      raise exception 'line_variant_missing' using errcode = 'P0001';
    end if;
    v_key := 'po_receive:' || p_receipt_id::text || ':' || ln.id::text;
    -- Replayed submission (retry after a committed call): line already applied.
    perform 1 from public.inventory_ledger
      where shop_id = p_shop_id and idempotency_key = v_key;
    if found then continue; end if;
    v_new_total := ln.qty_received + entry.qty;
    if v_new_total > ln.qty_ordered then
      raise exception 'receive_exceeds_ordered' using errcode = 'P0001';
    end if;

    insert into public.inventory_balance (shop_id, variant_id, location_id, on_hand, version, updated_at)
      values (p_shop_id, ln.variant_id, po.destination_location_id, entry.qty, 1, now())
      on conflict (variant_id, location_id) do update
        set on_hand = public.inventory_balance.on_hand + entry.qty,
            version = public.inventory_balance.version + 1,
            updated_at = now();
    insert into public.inventory_ledger (shop_id, variant_id, location_id, entry_type, qty, order_ref, idempotency_key, reason, source)
      values (p_shop_id, ln.variant_id, po.destination_location_id, 'receive', entry.qty,
              po.po_number, v_key, 'po_received', 'merchant');
    update public.purchase_order_line set qty_received = v_new_total where id = ln.id;
    v_variant_ids := v_variant_ids || ln.variant_id;
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
  -- After the line/status updates so the open remainder is current.
  foreach v_variant in array v_variant_ids loop
    perform public.po_recompute_incoming(p_shop_id, v_variant, po.destination_location_id);
  end loop;
  return jsonb_build_object(
    'variantIds', v_variants,
    'locationId', po.destination_location_id,
    'status', case when v_open = 0 then 'received' else 'partial' end);
end $$;

-- ---- po_cancel --------------------------------------------------------------
-- draft/ordered/partial → cancelled. For ordered/partial the remaining
-- expectation (qty_ordered - qty_received) is journaled out as a negative
-- 'in_transit' row per line, then incoming is recomputed from truth (the
-- cancelled PO no longer counts). Already-received stock stays. Lines whose
-- variant was deleted are skipped — their balance rows cascaded away with the
-- variant. Returns touched variant ids + destination (empty list for a draft —
-- no balances were touched).

create or replace function public.po_cancel(
  p_shop_id uuid, p_po_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare po record; ln record; v_remaining int; v_variant uuid;
        v_variant_ids uuid[] := '{}'; v_variants jsonb := '[]'::jsonb;
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
      if ln.variant_id is null then continue; end if;
      v_remaining := ln.qty_ordered - ln.qty_received;
      if v_remaining > 0 then
        insert into public.inventory_ledger (shop_id, variant_id, location_id, entry_type, qty, order_ref, idempotency_key, reason, source)
          values (p_shop_id, ln.variant_id, po.destination_location_id, 'in_transit', -v_remaining,
                  po.po_number, 'po_cancel:' || ln.id::text, 'po_cancelled', 'merchant');
        v_variant_ids := v_variant_ids || ln.variant_id;
        v_variants := v_variants || to_jsonb(ln.variant_id::text);
      end if;
    end loop;
  end if;

  update public.purchase_order
     set status = 'cancelled', cancelled_at = now(), updated_at = now()
   where id = p_po_id;
  -- After the status flip so this PO's remainder no longer counts.
  foreach v_variant in array v_variant_ids loop
    perform public.po_recompute_incoming(p_shop_id, v_variant, po.destination_location_id);
  end loop;
  return jsonb_build_object('variantIds', v_variants, 'locationId', po.destination_location_id);
end $$;

-- ---- po_update_draft --------------------------------------------------------
-- Atomic draft edit: lock the header FOR UPDATE, refuse anything that left
-- draft (po_not_draft), then apply the header patch and replace-all lines in
-- the one transaction. Done in SQL because PostgREST offers no cross-statement
-- transaction: a separate update + delete + insert could destroy the lines of
-- a PO that was concurrently marked ordered (orphaning its booked incoming) or
-- leave a half-edited draft when the re-insert failed.
-- p_header = {supplier_id, vendor_name, destination_location_id, expected_at, notes};
-- p_lines  = [{variant_id, sku, variant_title, qty_ordered, unit_cost_cents}].

create or replace function public.po_update_draft(
  p_shop_id uuid, p_po_id uuid, p_header jsonb, p_lines jsonb
) returns void language plpgsql security definer set search_path = '' as $$
declare po record;
begin
  select * into po from public.purchase_order
    where id = p_po_id and shop_id = p_shop_id for update;
  if not found then raise exception 'po_not_found' using errcode = 'P0001'; end if;
  if po.status <> 'draft' then raise exception 'po_not_draft' using errcode = 'P0001'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'po_empty' using errcode = 'P0001';
  end if;

  update public.purchase_order
     set supplier_id = (p_header ->> 'supplier_id')::uuid,
         vendor_name = p_header ->> 'vendor_name',
         destination_location_id = (p_header ->> 'destination_location_id')::uuid,
         expected_at = (p_header ->> 'expected_at')::date,
         notes = p_header ->> 'notes',
         updated_at = now()
   where id = p_po_id;

  delete from public.purchase_order_line where po_id = p_po_id and shop_id = p_shop_id;
  insert into public.purchase_order_line
      (shop_id, po_id, variant_id, sku, variant_title, qty_ordered, unit_cost_cents)
    select p_shop_id, p_po_id,
           (e ->> 'variant_id')::uuid,
           e ->> 'sku',
           e ->> 'variant_title',
           (e ->> 'qty_ordered')::int,
           (e ->> 'unit_cost_cents')::int
      from jsonb_array_elements(p_lines) e;
end $$;

-- ---- po_list ----------------------------------------------------------------
-- One page of the PO list with per-PO line aggregates computed in SQL, so the
-- page never depends on PostgREST's 1000-row response clamp (a single
-- .in(po_id, ids) line fetch silently truncates for large pages).
-- total_cents follows the DTO rule: sum of the KNOWN unit costs, null when no
-- line has one (rendered "TBD", never $0). total_count is the window count of
-- all the shop's POs.

create or replace function public.po_list(
  p_shop_id uuid, p_limit int, p_offset int
) returns table (
  id uuid, po_number text, vendor_name text, destination_name text,
  status text, expected_at date, source text,
  created_at timestamptz, updated_at timestamptz,
  line_count bigint, units_ordered bigint, units_received bigint,
  total_cents bigint, total_count bigint
) language sql stable security definer set search_path = '' as $$
  select po.id, po.po_number, po.vendor_name,
         coalesce(loc.name, 'Location') as destination_name,
         po.status, po.expected_at, po.source, po.created_at, po.updated_at,
         coalesce(agg.line_count, 0) as line_count,
         coalesce(agg.units_ordered, 0) as units_ordered,
         coalesce(agg.units_received, 0) as units_received,
         agg.total_cents,
         count(*) over () as total_count
    from public.purchase_order po
    left join public.location_dim loc on loc.id = po.destination_location_id
    left join lateral (
      select count(*) as line_count,
             sum(l.qty_ordered) as units_ordered,
             sum(l.qty_received) as units_received,
             (case when count(l.unit_cost_cents) = 0 then null
                   else sum(l.qty_ordered::bigint * l.unit_cost_cents) end)::bigint as total_cents
        from public.purchase_order_line l
       where l.po_id = po.id and l.shop_id = p_shop_id
    ) agg on true
   where po.shop_id = p_shop_id
   order by po.created_at desc
   limit greatest(p_limit, 0) offset greatest(p_offset, 0)
$$;

-- ---- grants -----------------------------------------------------------------
-- security definer functions must not be callable by anon/authenticated; the
-- app always goes through the service role. Revoking from PUBLIC matters —
-- revoking only from anon leaves the default PUBLIC execute grant in place.

revoke all on function public.po_recompute_incoming(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.po_mark_ordered(uuid, uuid) from public, anon, authenticated;
revoke all on function public.po_receive(uuid, uuid, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.po_cancel(uuid, uuid) from public, anon, authenticated;
revoke all on function public.po_update_draft(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.po_list(uuid, int, int) from public, anon, authenticated;
grant execute on function public.po_recompute_incoming(uuid, uuid, uuid) to service_role;
grant execute on function public.po_mark_ordered(uuid, uuid) to service_role;
grant execute on function public.po_receive(uuid, uuid, jsonb, uuid) to service_role;
grant execute on function public.po_cancel(uuid, uuid) to service_role;
grant execute on function public.po_update_draft(uuid, uuid, jsonb, jsonb) to service_role;
grant execute on function public.po_list(uuid, int, int) to service_role;
