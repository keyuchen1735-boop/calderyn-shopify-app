-- inventory_list v3: merchant-selectable column ordering.
--
-- The Inventory screen's column headers now sort, and the list is paged
-- (50 rows at a time behind "load more"), so the ordering has to be applied
-- server-side over the whole filtered set — sorting only the loaded page would
-- answer "highest on hand" with "highest among the first 50".
--
-- p_sort/p_dir are allowlisted by the caller and matched here against literal
-- values inside CASE arms, so the ORDER BY is fully static: no dynamic SQL, no
-- injection surface, and the function stays `language sql` / `stable`.
-- Anything unrecognized (including NULL) falls through to the v2 default of
-- lowest-stock-first, which is what makes the screen useful for spotting
-- problems and remains the third-click destination in the UI's sort cycle.
--
-- Every branch ends on the same (product_title, variant_id) tiebreak. That is
-- load-bearing, not cosmetic: offset pagination over a non-deterministic order
-- duplicates and drops rows between pages whenever the sort column ties, and
-- on_hand/reserved/available tie constantly.
--
-- Rollup semantics (active-locations-only balances, velocity-aware `low`) are
-- unchanged from v2.

-- Postgres identifies a function by its argument types, so adding p_sort/p_dir
-- would leave the v2 five-argument function in place as a second overload and
-- make the existing five-named-argument RPC call ambiguous. Drop it first.
-- Safe to drop: v2 carried no grants and no SECURITY DEFINER — it runs as the
-- server-side caller.
drop function if exists public.inventory_list(uuid, text, text, int, int);

create or replace function public.inventory_list(
  p_shop_id uuid,
  p_search text default null,
  p_stock text default null,
  p_limit int default 50,
  p_offset int default 0,
  p_sort text default null,
  p_dir text default null
) returns table (
  variant_id uuid,
  product_id uuid,
  sku text,
  variant_title text,
  product_title text,
  on_hand bigint,
  reserved bigint,
  incoming bigint,
  available bigint,
  low boolean,
  location_count bigint,
  single_location_id uuid,
  total_count bigint
)
language sql
stable
set search_path = ''
as $$
  with rolled as (
    select
      v.id as variant_id,
      v.product_id,
      v.sku,
      v.title as variant_title,
      p.title as product_title,
      coalesce(sum(b.on_hand), 0)::bigint as on_hand,
      coalesce(sum(b.reserved), 0)::bigint as reserved,
      coalesce(sum(b.incoming), 0)::bigint as incoming,
      coalesce(sum(b.available), 0)::bigint as available,
      (
        coalesce(bool_or(b.reorder_point is not null and b.available <= b.reorder_point), false)
        or coalesce(
          max(s.days_of_cover) < 21
            and not coalesce(bool_or(s.do_not_reorder), false)
            and coalesce(sum(b.on_hand), 0) > 0,
          false
        )
      ) as low,
      count(b.location_id)::bigint as location_count,
      (case when count(b.location_id) = 1 then min(b.location_id::text)::uuid else null end) as single_location_id
    from public.variant_dim v
    join public.product_dim p on p.id = v.product_id
    left join (
      public.inventory_balance b
      join public.location_dim l
        on l.id = b.location_id
       and l.shop_id = p_shop_id
       and coalesce(l.active, true)
    ) on b.variant_id = v.id and b.shop_id = p_shop_id
    -- v_skus_flat is one row per (shop, sku); its columns feed `low` through
    -- aggregates (max/bool_or) so the variant grouping stays untouched.
    left join public.v_skus_flat s
      on s.shop_id = p_shop_id and s.sku = v.sku
    where v.shop_id = p_shop_id
      and p.status <> 'archived'
      and coalesce(v.inventory_tracked, true)
      and (
        p_search is null or p_search = ''
        or v.sku ilike '%' || p_search || '%'
        or v.title ilike '%' || p_search || '%'
        or p.title ilike '%' || p_search || '%'
      )
    group by v.id, v.product_id, v.sku, v.title, p.title
  ),
  filtered as (
    select * from rolled
    where p_stock is null
       or (p_stock = 'out' and on_hand <= 0)
       or (p_stock = 'low' and (low or on_hand <= 0))
  ),
  ranked as (
    -- The Status column sorts by how much attention a row needs rather than by
    -- the badge's alphabetical label: out of stock (2) before low (1) before
    -- healthy (0). Mirrors stockStatus() in the Inventory screen.
    select f.*, (case when f.on_hand <= 0 then 2 when f.low then 1 else 0 end) as status_rank
    from filtered f
  )
  select
    r.variant_id,
    r.product_id,
    r.sku,
    r.variant_title,
    r.product_title,
    r.on_hand,
    r.reserved,
    r.incoming,
    r.available,
    r.low,
    r.location_count,
    r.single_location_id,
    count(*) over ()::bigint as total_count
  from ranked r
  order by
    -- Default ordering (no/unknown sort key): lowest stock first, as in v2.
    case when p_sort is null or p_sort not in ('product', 'on_hand', 'reserved', 'available', 'status')
         then r.on_hand end asc,
    case when p_sort = 'product'   and p_dir = 'asc'  then r.product_title end asc,
    case when p_sort = 'product'   and p_dir = 'desc' then r.product_title end desc,
    case when p_sort = 'on_hand'   and p_dir = 'asc'  then r.on_hand end asc,
    case when p_sort = 'on_hand'   and p_dir = 'desc' then r.on_hand end desc,
    case when p_sort = 'reserved'  and p_dir = 'asc'  then r.reserved end asc,
    case when p_sort = 'reserved'  and p_dir = 'desc' then r.reserved end desc,
    case when p_sort = 'available' and p_dir = 'asc'  then r.available end asc,
    case when p_sort = 'available' and p_dir = 'desc' then r.available end desc,
    case when p_sort = 'status'    and p_dir = 'asc'  then r.status_rank end asc,
    case when p_sort = 'status'    and p_dir = 'desc' then r.status_rank end desc,
    -- Deterministic tiebreak on every branch: offset pagination needs a total
    -- order, and the numeric columns above tie heavily.
    r.product_title asc,
    r.variant_id asc
  limit greatest(p_limit, 0) offset greatest(p_offset, 0)
$$;
