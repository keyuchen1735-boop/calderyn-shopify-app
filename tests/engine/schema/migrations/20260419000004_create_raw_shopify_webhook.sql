-- supabase/migrations/20260419000004_create_raw_shopify_webhook.sql
create table public.raw_shopify_webhook (
  id             bigserial primary key,
  shop_id        uuid not null references public.shops(id) on delete cascade,
  topic          text not null,                 -- e.g. 'orders/create'
  webhook_id     text not null,                 -- Shopify X-Shopify-Webhook-Id header
  received_at    timestamptz not null default now(),
  hmac_verified  boolean not null,
  payload        jsonb not null,
  unique (webhook_id)                           -- idempotency
);

alter table public.raw_shopify_webhook enable row level security;

create index raw_shopify_webhook_shop_topic_idx on public.raw_shopify_webhook (shop_id, topic, received_at desc);
