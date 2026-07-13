-- Atomic PO create + status-filtered listing.
--
-- po_create replaces the app's two-request create path (header insert, then
-- line insert with best-effort cleanup) with one transaction, so a failed
-- create can never strand a lineless header again. po_list gains an optional
-- status filter; p_status defaults to null so the deployed three-argument
-- caller keeps resolving while the new code rolls out.

-- Create the header and every line in one transaction. For promoted Autopilot
-- drafts, audit_id is the request identity: a retry returns the existing PO
-- (checked BEFORE payload validation, so a completed promote replays cleanly
-- even if its location/supplier has since changed), while a legacy draft
-- header stranded by the old two-request create path is repaired by updating
-- its header to the freshly validated payload (po_number stays stable) and
-- adding the missing lines atomically.
create or replace function public.po_create(
  p_shop_id uuid,
  p_po_number text,
  p_supplier_id uuid,
  p_vendor_name text,
  p_destination_location_id uuid,
  p_expected_at date,
  p_notes text,
  p_source text,
  p_audit_id uuid,
  p_lines jsonb
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_po_id uuid; v_status text;
begin
  if p_audit_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        p_shop_id::text || ':po_audit:' || p_audit_id::text, 0));
    select po.id, po.status into v_po_id, v_status
      from public.purchase_order po
     where po.shop_id = p_shop_id and po.audit_id = p_audit_id
     for update;
    if found then
      perform 1 from public.purchase_order_line line
        where line.shop_id = p_shop_id and line.po_id = v_po_id;
      if found then
        return v_po_id;
      end if;
      if v_status <> 'draft' then
        raise exception 'po_not_draft' using errcode = 'P0001';
      end if;
      -- Repair only the known legacy failure shape: a draft header with zero
      -- lines. The header is re-pointed at the validated payload below.
    end if;
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array'
     or jsonb_array_length(p_lines) = 0 then
    raise exception 'po_empty' using errcode = 'P0001';
  end if;
  if p_source not in ('manual','autopilot') then
    raise exception 'invalid_po' using errcode = 'P0001';
  end if;
  perform 1 from public.location_dim
    where id = p_destination_location_id and shop_id = p_shop_id
      and coalesce(active, true);
  if not found then
    raise exception 'location_inactive' using errcode = 'P0001';
  end if;
  if p_supplier_id is not null then
    perform 1 from public.supplier_dim
      where id = p_supplier_id and shop_id = p_shop_id;
    if not found then
      raise exception 'supplier_not_found' using errcode = 'P0001';
    end if;
  end if;
  perform 1
    from jsonb_array_elements(p_lines) line
    left join public.variant_dim variant
      on variant.id = (line ->> 'variant_id')::uuid
     and variant.shop_id = p_shop_id
   where variant.id is null;
  if found then
    raise exception 'variant_not_found' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_lines) <>
     (select count(distinct (line ->> 'variant_id')::uuid)
        from jsonb_array_elements(p_lines) line) then
    raise exception 'invalid_po' using errcode = 'P0001';
  end if;

  if v_po_id is null then
    insert into public.purchase_order
        (shop_id, po_number, supplier_id, vendor_name,
         destination_location_id, expected_at, notes, source, audit_id)
      values
        (p_shop_id, p_po_number, p_supplier_id, p_vendor_name,
         p_destination_location_id, p_expected_at, p_notes, p_source,
         p_audit_id)
      returning id into v_po_id;
  else
    -- Repairing a stranded lineless header: adopt the validated payload so
    -- the PO can't keep pointing at a since-deactivated location or a stale
    -- vendor snapshot. Only the issued po_number is preserved.
    update public.purchase_order
       set supplier_id = p_supplier_id,
           vendor_name = p_vendor_name,
           destination_location_id = p_destination_location_id,
           expected_at = p_expected_at,
           notes = p_notes,
           source = p_source,
           updated_at = now()
     where shop_id = p_shop_id and id = v_po_id;
  end if;

  insert into public.purchase_order_line
      (shop_id, po_id, variant_id, sku, variant_title,
       qty_ordered, unit_cost_cents)
    select p_shop_id, v_po_id,
           (line ->> 'variant_id')::uuid,
           line ->> 'sku',
           line ->> 'variant_title',
           (line ->> 'qty_ordered')::int,
           (line ->> 'unit_cost_cents')::int
      from jsonb_array_elements(p_lines) line;
  return v_po_id;
end $$;

-- Replace the unfiltered three-argument list RPC. Filtering and the window
-- total use the same predicate, so pagination remains honest within a status.
-- p_status defaults to null (= all statuses) so callers built against the
-- three-argument signature keep working until they redeploy.
drop function public.po_list(uuid, int, int);
create function public.po_list(
  p_shop_id uuid, p_limit int, p_offset int, p_status text default null
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
    left join public.location_dim loc
      on loc.id = po.destination_location_id and loc.shop_id = p_shop_id
    left join lateral (
      select count(*) as line_count,
             sum(line.qty_ordered) as units_ordered,
             sum(line.qty_received) as units_received,
             (case when count(line.unit_cost_cents) = 0 then null
                   else sum(line.qty_ordered::bigint * line.unit_cost_cents) end)::bigint
               as total_cents
        from public.purchase_order_line line
       where line.po_id = po.id and line.shop_id = p_shop_id
    ) agg on true
   where po.shop_id = p_shop_id
     and (p_status is null or po.status = p_status)
   order by po.created_at desc
   limit greatest(p_limit, 0) offset greatest(p_offset, 0)
$$;

revoke all on function public.po_create(
  uuid, text, uuid, text, uuid, date, text, text, uuid, jsonb
) from public, anon, authenticated;
revoke all on function public.po_list(uuid, int, int, text)
  from public, anon, authenticated;
grant execute on function public.po_create(
  uuid, text, uuid, text, uuid, date, text, text, uuid, jsonb
) to service_role;
grant execute on function public.po_list(uuid, int, int, text) to service_role;
