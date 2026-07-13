-- supabase/migrations/20260710090000_orders_list_unified.sql
-- Phase 2 list power tools: merchant-saved list views + the unified list read
-- model (native orders UNION imported Shopify history) that search/filter/sort/
-- pagination, CSV export, and the toolbar all consume. Shop-scoped throughout.

-- 1) Saved views.
create table if not exists public.order_view (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  name text not null check (length(name) between 1 and 60),
  filters jsonb not null default '{}'::jsonb,
  position int not null default 0,
  created_at timestamptz not null default now(),
  unique (shop_id, name)
);
alter table public.order_view enable row level security;
create policy order_view_shop_scope on public.order_view
  for all using (shop_id = public.current_shop_id()) with check (shop_id = public.current_shop_id());
revoke all on table public.order_view from anon, authenticated;

-- 2) Unified list. Fulfillment filter EXCLUDES imported rows (no fulfillment
-- concept there); archived filter is native-only by construction (imported rows
-- have no archived_at and always pass unless p_archived filters them out — they
-- pass the default view). One page + the true total via count(*) over ().
create or replace function public.list_orders_unified(
  p_shop_id uuid,
  p_search text default null,
  p_payment_status text[] default null,
  p_fulfillment_status text default null,
  p_source text default null,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null,
  p_tag text default null,
  p_archived boolean default false,
  p_sort text default 'date',
  p_dir text default 'desc',
  p_offset int default 0,
  p_limit int default 50
) returns table (
  source text, id uuid, ref text, buyer_email text,
  total_cents bigint, currency text, payment_status text, state text,
  cancelled_at timestamptz, archived_at timestamptz, occurred_at timestamptz,
  item_count bigint, tags text[], remaining_refundable_cents bigint, full_count bigint
) language sql stable set search_path = '' as $$
  with unified as (
    select
      'calderyn'::text as source,
      o.id,
      '#' || upper(left(replace(o.id::text, '-', ''), 8)) as ref,
      b.email_normalized as buyer_email,
      o.total_cents::bigint as total_cents,
      o.currency,
      coalesce(o.financial_status, 'pending') as payment_status,
      o.state,
      o.cancelled_at,
      o.archived_at,
      o.created_at as occurred_at,
      coalesce((select sum(l.quantity) from public.order_line l
                where l.shop_id = o.shop_id and l.order_id = o.id), 0)::bigint as item_count,
      coalesce((select array_agg(t.tag order by t.tag) from public.order_tag t
                where t.shop_id = o.shop_id and t.order_id = o.id), '{}'::text[]) as tags,
      greatest(coalesce((select sum(tl.amount_cents) from public.transaction_ledger tl
                where tl.shop_id = o.shop_id and tl.order_ref = o.id::text
                  and tl.kind in ('capture','refund')), o.total_cents), 0)::bigint as remaining_refundable_cents
    from public.orders o
    left join public.buyer_dim b on b.shop_id = o.shop_id and b.id = o.buyer_id
    where o.shop_id = p_shop_id
      and o.channel <> 'test'
      and (o.state <> 'checkout_pending' or o.created_at >= now() - interval '1 hour')
    union all
    select
      'shopify'::text,
      io.id,
      coalesce(io.order_number, '#' || upper(left(replace(io.id::text, '-', ''), 8))),
      b2.email_normalized,
      io.total_cents::bigint,
      io.currency,
      coalesce(io.financial_status, 'pending'),
      coalesce(io.financial_status, 'pending'),  -- state carries financial status (badge convention)
      null::timestamptz, null::timestamptz,
      coalesce(io.processed_at, now()),
      coalesce((select sum(il.quantity) from public.imported_order_line il
                where il.shop_id = io.shop_id and il.imported_order_id = io.id), 0)::bigint,
      '{}'::text[],
      0::bigint
    from public.imported_order io
    left join public.buyer_dim b2 on b2.shop_id = io.shop_id and b2.id = io.buyer_id
    where io.shop_id = p_shop_id
  )
  select u.*, count(*) over ()::bigint as full_count
  from unified u
  where (p_source is null or u.source = p_source)
    and (p_payment_status is null or u.payment_status = any (p_payment_status))
    and (p_fulfillment_status is null or (u.source = 'calderyn' and (
          (p_fulfillment_status = 'unfulfilled' and u.state = 'paid')
          or (p_fulfillment_status = 'partially_fulfilled' and u.state = 'partially_fulfilled')
          or (p_fulfillment_status = 'fulfilled' and u.state = 'fulfilled'))))
    and (case when p_archived then (u.source = 'calderyn' and u.archived_at is not null)
              else (u.source = 'shopify' or u.archived_at is null) end)
    and (p_date_from is null or u.occurred_at >= p_date_from)
    and (p_date_to is null or u.occurred_at <= p_date_to)
    and (p_tag is null or lower(p_tag) = any (select lower(x) from unnest(u.tags) x))
    and (p_search is null or p_search = '' or
         u.ref ilike '%' || replace(p_search, '#', '') || '%'
         or u.buyer_email ilike '%' || p_search || '%'
         or lower(p_search) = any (select lower(x) from unnest(u.tags) x))
  order by
    case when p_sort = 'total' and p_dir = 'desc' then u.total_cents end desc nulls last,
    case when p_sort = 'total' and p_dir = 'asc' then u.total_cents end asc nulls last,
    case when p_sort = 'customer' and p_dir = 'desc' then u.buyer_email end desc nulls last,
    case when p_sort = 'customer' and p_dir = 'asc' then u.buyer_email end asc nulls last,
    case when p_sort = 'date' and p_dir = 'asc' then u.occurred_at end asc,
    u.occurred_at desc,
    u.id desc
  offset greatest(p_offset, 0)
  limit least(greatest(p_limit, 1), 1000)
$$;
