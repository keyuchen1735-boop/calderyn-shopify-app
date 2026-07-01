-- Owned-event ingest intake (platform pivot Step 5 / IngestETL). Calderyn's own
-- checkout emits fact-shaped CHECKOUT_COMPLETED events here; transformPendingOwnedEvents
-- turns them into order_fact / order_line_fact / attribution_fact. Kept separate from
-- raw_shopify_webhook so a native event can never collide with Shopify topic dispatch.
-- Service-role only: RLS enabled with no policy (deny to anon/authenticated), matching
-- the inventory intake tables; grants revoked for defense in depth on a payload table.

create table if not exists public.raw_owned_event (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references public.shops(id) on delete cascade,
  event_id     text not null,
  type         text not null,
  payload      jsonb not null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  unique (shop_id, event_id)
);
create index if not exists raw_owned_event_unprocessed_idx
  on public.raw_owned_event (received_at)
  where processed_at is null;
alter table public.raw_owned_event enable row level security;
revoke all on table public.raw_owned_event from anon, authenticated;

-- Pseudonymous buyer link on the warehouse order (never PII). Nullable + additive so
-- every existing order_fact reader is unaffected; buyer PII stays in the OLTP buyer_dim.
alter table public.order_fact add column if not exists buyer_id uuid;
