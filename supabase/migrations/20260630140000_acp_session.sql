-- An ACP checkout session: the protocol's stateful handle that maps to our locked quote and,
-- once completed, our owned order. client_id ties it to the registered AI client for the cap.
--
-- SCHEMA NOTE (LEARNING override): plan specified shop_id text + order_id text; both are uuid in
-- the live schema (all tables carry uuid shop_id referencing shops(id); orders.id is uuid).
-- RLS pattern from 20260629130000_commerce_quote_core.sql: enable RLS, shop-scope policy,
-- revoke from anon/authenticated.
create table if not exists public.acp_session (
  session_id  text        primary key,
  shop_id     uuid        not null references public.shops(id) on delete cascade,
  client_id   text        not null,
  quote_id    uuid,                               -- set on create/update (the locked quote)
  order_id    uuid,                               -- set on complete (orders.id)
  status      text        not null default 'open', -- open | completed | canceled
  buyer_email text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_acp_session_shop on public.acp_session (shop_id, created_at desc);

alter table public.acp_session enable row level security;
create policy acp_session_shop_scope on public.acp_session
  for all
  using  (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.acp_session from anon, authenticated;
