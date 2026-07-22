-- po_list: merchant-selectable column ordering for the purchase-order table.
--
-- The PO table's column headers now sort, and the list is paged (50 rows at a
-- time behind "load more"), so the ordering has to be applied over the whole
-- filtered set rather than the loaded page — same reasoning as inventory_list
-- v3 (20260722120000_inventory_list_fn_v3.sql).
--
-- p_sort/p_dir are allowlisted by the caller and matched here against literal
-- values inside CASE arms, so the ORDER BY stays fully static: no dynamic SQL,
-- no injection surface, and the function stays `language sql` / `stable`.
-- Anything unrecognized (including NULL) falls through to the newest-first
-- default, which remains the third-click destination in the UI's sort cycle.
--
-- Every branch keeps the (created_at desc, id desc) tail from
-- 20260718120000_po_list_stable_order.sql. That tiebreak is load-bearing:
-- LIMIT/OFFSET over a non-total order can return a boundary row on neither
-- page, silently dropping it (the client de-dupes duplicates but cannot
-- recover a skipped row), and status/expected_at/supplier tie constantly.
--
-- Postgres identifies a function by its argument types, so adding p_sort/p_dir
-- would leave the four-argument po_list in place as a second overload and make
-- the existing four-named-argument RPC call ambiguous. It has to be dropped,
-- which also drops its grants — the revoke/grant pair from
-- 20260712010000_po_create_atomic.sql is reproduced verbatim at the bottom.
drop function if exists public.po_list(uuid, int, int, text);

create or replace function public.po_list(
  p_shop_id uuid, p_limit int, p_offset int, p_status text default null,
  p_sort text default null, p_dir text default null
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
   order by
     -- Supplier is nullable and Expected is unset on drafts: those rows sink to
     -- the bottom in both directions rather than clustering at the top of an
     -- ascending sort. They are unknowns, not empty strings or old dates.
     case when p_sort = 'supplier'  and p_dir = 'asc'  then po.vendor_name end asc nulls last,
     case when p_sort = 'supplier'  and p_dir = 'desc' then po.vendor_name end desc nulls last,
     case when p_sort = 'expected'  and p_dir = 'asc'  then po.expected_at end asc nulls last,
     case when p_sort = 'expected'  and p_dir = 'desc' then po.expected_at end desc nulls last,
     case when p_sort = 'po'        and p_dir = 'asc'  then po.po_number end asc,
     case when p_sort = 'po'        and p_dir = 'desc' then po.po_number end desc,
     case when p_sort = 'destination' and p_dir = 'asc'  then coalesce(loc.name, 'Location') end asc,
     case when p_sort = 'destination' and p_dir = 'desc' then coalesce(loc.name, 'Location') end desc,
     case when p_sort = 'lines'     and p_dir = 'asc'  then coalesce(agg.line_count, 0) end asc,
     case when p_sort = 'lines'     and p_dir = 'desc' then coalesce(agg.line_count, 0) end desc,
     case when p_sort = 'status'    and p_dir = 'asc'  then po.status end asc,
     case when p_sort = 'status'    and p_dir = 'desc' then po.status end desc,
     -- Deterministic tail on every branch, including the default.
     po.created_at desc, po.id desc
   limit greatest(p_limit, 0) offset greatest(p_offset, 0)
$$;

-- Reproduced from 20260712010000_po_create_atomic.sql: the drop above took the
-- old signature's grants with it. Revoking from public as well as the two
-- Supabase client roles matters — revoking only from anon/authenticated would
-- leave the default PUBLIC execute grant in place on a security-definer
-- function.
revoke all on function public.po_list(uuid, int, int, text, text, text)
  from public, anon, authenticated;
grant execute on function public.po_list(uuid, int, int, text, text, text) to service_role;
