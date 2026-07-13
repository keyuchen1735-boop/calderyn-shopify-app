-- inventory_list v2: active-locations-only rollups + velocity-aware low.
--
-- a) Balance rows are only aggregated when their location is still active
--    (coalesce(l.active, true) — a NULL flag counts as active). Deactivated
--    locations always hold zero stock (the deactivation guard refuses while
--    any units remain), but their leftover zero rows must not inflate
--    location_count (which would offer inline edits at inactive locations)
--    or trigger phantom reorder-point lows.
-- b) low additionally flags velocity risk from v_skus_flat: under 21 days of
--    cover while stock is still on hand and the sku isn't discontinued
--    (do_not_reorder). Out-of-stock semantics are unchanged: low means
--    at-risk, on_hand <= 0 is "out".
create or replace function public.inventory_list(
  p_shop_id uuid,
  p_search text default null,
  p_stock text default null,
  p_limit int default 50,
  p_offset int default 0
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
  )
  select f.*, count(*) over ()::bigint as total_count
  from filtered f
  order by f.on_hand asc, f.product_title asc, f.variant_id asc
  limit greatest(p_limit, 0) offset greatest(p_offset, 0)
$$;
