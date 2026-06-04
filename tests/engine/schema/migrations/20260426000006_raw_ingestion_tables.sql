-- supabase/migrations/20260426000006_raw_ingestion_tables.sql
-- Plan 02 Task 8: append-only raw_*_poll tables + ingestion_dlq for permanent failures.

create table public.raw_meta_poll (
  id        bigserial primary key,
  shop_id   uuid not null references public.shops(id) on delete cascade,
  poll_kind text not null,                                                  -- 'campaigns' | 'insights' | 'creatives'
  polled_at timestamptz not null default now(),
  payload   jsonb not null
);

create table public.raw_google_poll (
  id        bigserial primary key,
  shop_id   uuid not null references public.shops(id) on delete cascade,
  poll_kind text not null,
  polled_at timestamptz not null default now(),
  payload   jsonb not null
);

create table public.raw_quickbooks_poll (
  id        bigserial primary key,
  shop_id   uuid not null references public.shops(id) on delete cascade,
  poll_kind text not null,
  polled_at timestamptz not null default now(),
  payload   jsonb not null
);

create table public.ingestion_dlq (
  id            bigserial primary key,
  shop_id       uuid references public.shops(id) on delete cascade,
  connector     text not null,
  job_kind      text not null,
  failed_at     timestamptz not null default now(),
  attempts      integer not null,
  error_kind    text not null,                                              -- 'auth_expired' | 'permission_denied' | 'permanent' | 'unknown'
  error_message text,
  payload       jsonb not null
);

create index raw_meta_shop_time_idx on public.raw_meta_poll (shop_id, polled_at desc);
create index raw_google_shop_time_idx on public.raw_google_poll (shop_id, polled_at desc);
create index raw_qb_shop_time_idx on public.raw_quickbooks_poll (shop_id, polled_at desc);
create index ingestion_dlq_shop_time_idx on public.ingestion_dlq (shop_id, failed_at desc);

alter table public.raw_meta_poll enable row level security;
alter table public.raw_google_poll enable row level security;
alter table public.raw_quickbooks_poll enable row level security;
alter table public.ingestion_dlq enable row level security;

-- No SELECT policies — workers read under service_role; merchants do not view raw payloads.
