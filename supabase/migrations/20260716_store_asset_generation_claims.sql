alter table public.store_asset
  drop constraint if exists store_asset_status_check;
alter table public.store_asset
  alter column url drop not null,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists lease_expires_at timestamptz;

update public.store_asset
set url = null
where status = 'failed' and url = '';

alter table public.store_asset
  add constraint store_asset_status_check
    check (status in ('pending', 'ready', 'failed')),
  add constraint store_asset_ready_url_check
    check (status <> 'ready' or nullif(url, '') is not null),
  add constraint store_asset_attempt_count_check
    check (attempt_count >= 0);

create index if not exists store_asset_generation_queue_idx
  on public.store_asset (next_attempt_at, lease_expires_at, created_at)
  where source = 'gemini' and status in ('pending', 'failed');

create or replace function public.claim_missing_storefront_images(
  p_limit integer default 10
) returns table (
  shop_id uuid,
  product_id text,
  title text,
  description text,
  attempt_count integer,
  lease_expires_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $func$
declare
  v_seeded integer;
begin
  with missing as materialized (
    select
      p.shop_id,
      p.id::text as product_id,
      v.latest_version_at
    from public.product_dim p
    left join lateral (
      select max(sbv.created_at) as latest_version_at
      from public.storefront_bundle_version sbv
      where sbv.shop_id = p.shop_id
    ) v on true
    where p.status = 'active'
      and not exists (
        select 1 from public.product_media pm where pm.product_id = p.id
      )
      and not exists (
        select 1
        from public.store_asset ready
        where ready.shop_id = p.shop_id
          and ready.product_id = p.id::text
          and ready.status = 'ready'
      )
      and not exists (
        select 1
        from public.store_asset queued
        where queued.shop_id = p.shop_id
          and queued.product_id = p.id::text
          and queued.source = 'gemini'
      )
    order by latest_version_at desc nulls last, p.updated_at desc, p.shop_id, p.id
    limit greatest(0, least(coalesce(p_limit, 10), 50))
  ), seeded as (
    insert into public.store_asset as sa (
      shop_id, product_id, source, url, status, next_attempt_at
    )
    select m.shop_id, m.product_id, 'gemini', null, 'pending', now()
    from missing m
    on conflict on constraint store_asset_pkey do nothing
    returning sa.shop_id, sa.product_id
  )
  select count(*) into v_seeded from seeded;

  return query
  with candidates as materialized (
    select
      sa.shop_id,
      sa.product_id,
      p.title,
      coalesce(p.description, '') as description,
      v.latest_version_at
    from public.store_asset sa
    join public.product_dim p
      on p.shop_id = sa.shop_id and p.id::text = sa.product_id
    left join lateral (
      select max(sbv.created_at) as latest_version_at
      from public.storefront_bundle_version sbv
      where sbv.shop_id = sa.shop_id
    ) v on true
    where sa.source = 'gemini'
      and p.status = 'active'
      and sa.status in ('pending', 'failed')
      and (sa.next_attempt_at is null or sa.next_attempt_at <= now())
      and (sa.lease_expires_at is null or sa.lease_expires_at <= now())
      and not exists (
        select 1 from public.product_media pm where pm.product_id = p.id
      )
      and not exists (
        select 1
        from public.store_asset ready
        where ready.shop_id = sa.shop_id
          and ready.product_id = sa.product_id
          and ready.status = 'ready'
      )
    order by latest_version_at desc nulls last, p.updated_at desc, sa.created_at, sa.shop_id, sa.product_id
    limit greatest(0, least(coalesce(p_limit, 10), 50))
    for update of sa skip locked
  ), claimed as (
    update public.store_asset sa
    set status = 'pending',
        attempt_count = sa.attempt_count + 1,
        next_attempt_at = null,
        lease_expires_at = now() + interval '5 minutes'
    from candidates c
    where sa.shop_id = c.shop_id
      and sa.product_id = c.product_id
      and sa.source = 'gemini'
    returning
      sa.shop_id,
      sa.product_id,
      c.title,
      c.description,
      sa.attempt_count,
      sa.lease_expires_at
  )
  select
    c.shop_id,
    c.product_id,
    c.title,
    c.description,
    c.attempt_count,
    c.lease_expires_at
  from claimed c;
end;
$func$;

revoke all on function public.claim_missing_storefront_images(integer) from public, anon, authenticated;
grant execute on function public.claim_missing_storefront_images(integer) to service_role;
