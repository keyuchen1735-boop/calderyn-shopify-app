-- raw_shopify_webhook.processed_at: marks a landed webhook as transformed into facts.
-- The ingest-transform worker drains rows WHERE processed_at IS NULL.

alter table public.raw_shopify_webhook
  add column if not exists processed_at timestamptz null;

create index if not exists raw_shopify_webhook_unprocessed_idx
  on public.raw_shopify_webhook (received_at)
  where processed_at is null;
