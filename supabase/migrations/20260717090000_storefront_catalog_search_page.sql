create or replace function public.storefront_catalog_search_page(
  p_shop_id uuid,
  p_query text,
  p_collection text,
  p_category text,
  p_tag text,
  p_available boolean,
  p_sort text,
  p_after_value text,
  p_after_product_id uuid,
  p_limit integer
) returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
with
params as (
  select least(greatest(coalesce(p_limit, 1), 1), 24) as page_limit
),
base_candidates as materialized (
  select p.id, p.handle, p.title, p.description, p.category, p.tags
  from public.product_dim p
  where p.shop_id = p_shop_id
    and p.status = 'active'
    and p_sort in ('relevance', 'title_asc', 'title_desc', 'price_asc', 'price_desc')
    and (
      coalesce(p_query, '') = ''
      or pg_catalog.strpos(
        pg_catalog.lower(pg_catalog.concat_ws(
          ' ', p.title, coalesce(p.description, ''), coalesce(p.category, ''),
          pg_catalog.array_to_string(p.tags, ' ')
        )),
        pg_catalog.lower(p_query)
      ) > 0
    )
    and (
      p_collection is null
      or exists (
        select 1
        from public.product_collection pc
        join public.collection_dim collection on collection.id = pc.collection_id
        where pc.product_id = p.id
          and collection.shop_id = p_shop_id
          and pg_catalog.lower(collection.handle) = pg_catalog.lower(p_collection)
      )
    )
    and (p_category is null or pg_catalog.lower(coalesce(p.category, '')) = pg_catalog.lower(p_category))
    and (
      p_tag is null
      or exists (
        select 1
        from pg_catalog.unnest(p.tags) product_tag(value)
        where pg_catalog.lower(product_tag.value) = pg_catalog.lower(p_tag)
      )
    )
),
rollup_variant_state as materialized (
  select
    variant.product_id,
    variant.retail_price_cents,
    variant.retail_price_cents is not null
      and (
        not coalesce(variant.inventory_tracked, false)
        or coalesce(inventory.sellable, variant.inventory_on_hand::bigint, 0) > 0
      ) as available
  from base_candidates
  join public.variant_dim variant
    on variant.product_id = base_candidates.id and variant.shop_id = p_shop_id
  left join lateral (
    select sum(balance.available)::bigint as sellable
    from public.inventory_balance balance
    where balance.shop_id = p_shop_id and balance.variant_id = variant.id
  ) inventory on true
  where p_available is not null
    or p_sort in ('price_asc', 'price_desc')
),
variant_rollup as materialized (
  select
    variant.product_id,
    min(variant.retail_price_cents) filter (where variant.available)::bigint as sellable_price_cents,
    min(variant.retail_price_cents)::bigint as price_cents,
    bool_or(variant.available) as available
  from rollup_variant_state variant
  group by variant.product_id
),
filtered as materialized (
  select
    base_candidates.*,
    coalesce(
      variant_rollup.sellable_price_cents,
      variant_rollup.price_cents,
      case
        when p_sort = 'price_desc' then -2147483649::bigint
        else 9007199254740991::bigint
      end
    ) as price_cents
  from base_candidates
  left join variant_rollup on variant_rollup.product_id = base_candidates.id
  where p_available is null or coalesce(variant_rollup.available, false) = p_available
),
page_rows as materialized (
  select
    filtered.*,
    row_number() over (
      order by
        case when p_sort in ('relevance', 'title_asc') then filtered.title end asc,
        case when p_sort = 'title_desc' then filtered.title end desc,
        case when p_sort = 'price_asc' then filtered.price_cents end asc,
        case when p_sort = 'price_desc' then filtered.price_cents end desc,
        filtered.id asc
    ) as page_position
  from filtered
  where p_after_product_id is null
    or case p_sort
      when 'relevance' then filtered.title > p_after_value
        or (filtered.title = p_after_value and filtered.id > p_after_product_id)
      when 'title_asc' then filtered.title > p_after_value
        or (filtered.title = p_after_value and filtered.id > p_after_product_id)
      when 'title_desc' then filtered.title < p_after_value
        or (filtered.title = p_after_value and filtered.id > p_after_product_id)
      when 'price_asc' then filtered.price_cents > p_after_value::bigint
        or (filtered.price_cents = p_after_value::bigint and filtered.id > p_after_product_id)
      when 'price_desc' then filtered.price_cents < p_after_value::bigint
        or (filtered.price_cents = p_after_value::bigint and filtered.id > p_after_product_id)
      else false
    end
  order by
    case when p_sort in ('relevance', 'title_asc') then filtered.title end asc,
    case when p_sort = 'title_desc' then filtered.title end desc,
    case when p_sort = 'price_asc' then filtered.price_cents end asc,
    case when p_sort = 'price_desc' then filtered.price_cents end desc,
    filtered.id asc
  limit (select page_limit + 1 from params)
),
page_metadata as (
  select exists (
    select 1 from page_rows, params where page_rows.page_position > params.page_limit
  ) as has_next_page
),
boundary as (
  select
    case
      when p_sort in ('price_asc', 'price_desc') then pg_catalog.to_jsonb(page_rows.price_cents)
      else pg_catalog.to_jsonb(page_rows.title)
    end as sort_value,
    page_rows.id as product_id
  from page_rows, params
  where page_rows.page_position <= params.page_limit
  order by page_rows.page_position desc
  limit 1
),
card_rows as materialized (
  select
    page_rows.*,
    selected_variant.id as variant_id,
    selected_variant.sku as variant_sku,
    selected_variant.title as variant_title,
    selected_variant.price_cents as variant_price_cents,
    selected_variant.compare_at_price_cents as variant_compare_at_price_cents,
    selected_variant.currency as variant_currency,
    selected_variant.available as variant_available,
    selected_media.id as media_id,
    selected_media.storage_path,
    selected_media.external_url,
    selected_media.alt as media_alt
  from (
    select page_rows.*
    from page_rows, params
    where page_rows.page_position <= params.page_limit
  ) page_rows
  left join lateral (
    select candidate_variant.*
    from (
      select
        variant.id,
        variant.sku,
        coalesce(variant.title, 'Default') as title,
        variant.retail_price_cents::bigint as price_cents,
        variant.compare_at_price_cents::bigint as compare_at_price_cents,
        coalesce(variant.currency, 'USD') as currency,
        variant.retail_price_cents is not null
          and (
            not coalesce(variant.inventory_tracked, false)
            or coalesce(inventory.sellable, variant.inventory_on_hand::bigint, 0) > 0
          ) as available
      from public.variant_dim variant
      left join lateral (
        select sum(balance.available)::bigint as sellable
        from public.inventory_balance balance
        where balance.shop_id = p_shop_id and balance.variant_id = variant.id
      ) inventory on true
      where variant.shop_id = p_shop_id and variant.product_id = page_rows.id
    ) candidate_variant
    order by
      case
        when candidate_variant.available then 0
        when candidate_variant.price_cents is not null then 1
        else 2
      end,
      candidate_variant.price_cents asc nulls last,
      candidate_variant.id asc
    limit 1
  ) selected_variant on true
  left join lateral (
    select media.id, media.storage_path, media.external_url, media.alt
    from public.product_media media
    where media.product_id = page_rows.id
      and (media.storage_path is not null or media.external_url is not null)
    order by coalesce(media.is_primary, false) desc, media.position asc, media.id asc
    limit 1
  ) selected_media on true
),
category_facets as (
  select
    min(filtered.category collate pg_catalog."C") as value,
    count(distinct filtered.id)::bigint as count
  from filtered
  where filtered.category is not null and filtered.category <> ''
  group by pg_catalog.lower(filtered.category)
  order by count desc, value asc
  limit 20
),
tag_facets as (
  select
    min(product_tag.value collate pg_catalog."C") as value,
    count(distinct filtered.id)::bigint as count
  from filtered
  cross join lateral pg_catalog.unnest(filtered.tags) product_tag(value)
  where product_tag.value <> ''
  group by pg_catalog.lower(product_tag.value)
  order by count desc, value asc
  limit 20
),
collection_facets as (
  select
    min(collection.handle collate pg_catalog."C") as value,
    count(distinct filtered.id)::bigint as count
  from filtered
  join public.product_collection pc on pc.product_id = filtered.id
  join public.collection_dim collection
    on collection.id = pc.collection_id and collection.shop_id = p_shop_id
  where collection.handle <> ''
  group by pg_catalog.lower(collection.handle)
  order by count desc, value asc
  limit 20
)
select pg_catalog.jsonb_build_object(
  'cards', coalesce((
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', card_rows.id,
        'handle', card_rows.handle,
        'title', card_rows.title,
        'description', pg_catalog.left(coalesce(card_rows.description, ''), 500),
        'image', case when card_rows.media_id is null then null else pg_catalog.jsonb_build_object(
          'storage_path', card_rows.storage_path,
          'external_url', card_rows.external_url,
          'alt', card_rows.media_alt
        ) end,
        'variant', case when card_rows.variant_id is null then null else pg_catalog.jsonb_build_object(
          'id', card_rows.variant_id,
          'sku', card_rows.variant_sku,
          'title', card_rows.variant_title,
          'price_cents', card_rows.variant_price_cents,
          'compare_at_price_cents', card_rows.variant_compare_at_price_cents,
          'currency', card_rows.variant_currency,
          'available', card_rows.variant_available
        ) end
      ) order by card_rows.page_position
    )
    from card_rows
  ), '[]'::jsonb),
  'boundary', case when (select has_next_page from page_metadata) then (
    select pg_catalog.jsonb_build_object(
      'sort_value', boundary.sort_value,
      'product_id', boundary.product_id
    ) from boundary
  ) else null end,
  'total', (select count(*) from filtered),
  'has_next_page', (select has_next_page from page_metadata),
  'facets', pg_catalog.jsonb_build_object(
    'categories', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('value', category_facets.value, 'count', category_facets.count)
        order by category_facets.count desc, category_facets.value asc
      ) from category_facets
    ), '[]'::jsonb),
    'tags', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('value', tag_facets.value, 'count', tag_facets.count)
        order by tag_facets.count desc, tag_facets.value asc
      ) from tag_facets
    ), '[]'::jsonb),
    'collections', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('value', collection_facets.value, 'count', collection_facets.count)
        order by collection_facets.count desc, collection_facets.value asc
      ) from collection_facets
    ), '[]'::jsonb)
  )
);
$$;

revoke all on function public.storefront_catalog_search_page(
  uuid, text, text, text, text, boolean, text, text, uuid, integer
) from public, anon, authenticated;
grant execute on function public.storefront_catalog_search_page(
  uuid, text, text, text, text, boolean, text, text, uuid, integer
) to service_role;
