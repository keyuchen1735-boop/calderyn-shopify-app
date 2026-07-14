-- Durable, bounded repair state for Shopify order destinations.
-- Existing order_fact rows remain unchecked (null); every current webhook and
-- backfill write supplies destination_repair_checked_at at ingest time.
alter table public.order_fact
  add column if not exists destination_repair_checked_at timestamptz;

-- Scheduler state is integration-scoped. completed_at removes a shop from the
-- one-time sweep; attempted_at provides round-robin fairness across large or
-- transiently failing shops without storing any customer data.
alter table public.shop_integrations
  add column if not exists destination_repair_attempted_at timestamptz,
  add column if not exists destination_repair_completed_at timestamptz;

create index if not exists order_fact_destination_repair_idx
  on public.order_fact (shop_id, created_at_source, external_id)
  where destination_repair_checked_at is null;

create index if not exists shopify_destination_repair_queue_idx
  on public.shop_integrations (destination_repair_attempted_at)
  where kind = 'shopify'
    and sync_status in ('ready', 'live')
    and destination_repair_completed_at is null;

comment on column public.order_fact.destination_repair_checked_at is
  'Non-null after Shopify destination presence was checked; null is retryable repair work.';

-- Claim before doing any Shopify API work. The 30-minute lease matches the
-- cron cadence: overlapping cron/manual invocations skip fresh claims, while a
-- terminated worker becomes retryable on a later tick. SKIP LOCKED lets
-- concurrent claimers drain different tenants without waiting on each other.
create or replace function public.claim_order_destination_repairs(
  p_limit integer default 5
) returns table (
  shop_id uuid,
  shop_domain text,
  claimed_at timestamptz
)
language sql
security definer
set search_path = ''
as $func$
  with candidates as materialized (
    select si.shop_id
      from public.shop_integrations si
      join public.shops s on s.id = si.shop_id
     where si.kind = 'shopify'
       and si.sync_status in ('ready', 'live')
       and si.destination_repair_completed_at is null
       and (
         si.destination_repair_attempted_at is null
         or si.destination_repair_attempted_at <= now() - interval '30 minutes'
       )
     order by si.destination_repair_attempted_at asc nulls first, si.shop_id
     limit greatest(0, least(coalesce(p_limit, 5), 25))
       for update of si skip locked
  ), claimed as (
    update public.shop_integrations si
       set destination_repair_attempted_at = now()
      from candidates c
     where si.shop_id = c.shop_id
       and si.kind = 'shopify'
    returning si.shop_id, si.destination_repair_attempted_at as claimed_at
  )
  select c.shop_id, s.shop_domain, c.claimed_at
    from claimed c
    join public.shops s on s.id = c.shop_id
   order by c.claimed_at, c.shop_id;
$func$;

-- Functions receive PUBLIC execute by default. This definer path intentionally
-- bypasses tenant RLS for the all-shop cron, so expose it only to service_role.
revoke all on function public.claim_order_destination_repairs(integer) from public;
revoke execute on function public.claim_order_destination_repairs(integer) from anon, authenticated;
grant execute on function public.claim_order_destination_repairs(integer) to service_role;
