-- Stable pagination for po_list. The definition ordered only by created_at
-- desc; when two purchase orders share a created_at (seed data, Autopilot
-- promoting several drafts in the same instant) that order is not total, so
-- LIMIT/OFFSET can return a boundary row on neither page — silently dropping
-- it from the list (the client de-dupes duplicates but cannot recover a
-- skipped row). Add po.id as a deterministic tiebreaker. Body is otherwise
-- identical to the four-argument po_list from 20260712010000_po_create_atomic
-- (the deployed signature); create-or-replace keeps the existing grants.
create or replace function public.po_list(
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
   order by po.created_at desc, po.id desc
   limit greatest(p_limit, 0) offset greatest(p_offset, 0)
$$;
