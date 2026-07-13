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
