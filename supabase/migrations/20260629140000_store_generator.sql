-- supabase/migrations/20260629140000_store_generator.sql
-- Store generator (#16): promoted chrome settings + generation audit. RLS modeled on
-- buyer_identity (20260629100000): uuid shop_id, shop-scoped policy,
-- anon/authenticated grants revoked. The app reaches these via the service-role key only.
create table public.store_settings (
  shop_id       uuid primary key references public.shops(id) on delete cascade,
  store_name    text not null,
  palette       jsonb,
  logo_url      text,
  voice_tagline text,
  updated_at    timestamptz not null default now()
);

create table public.store_generation (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  run_id      text not null,
  source      text not null check (source in ('brief','catalog')),
  brief_text  text,
  model       text not null,
  status      text not null check (status in ('draft','failed','no_products')),
  token_cost  integer not null default 0,
  created_at  timestamptz not null default now()
);
create index store_generation_shop_idx on public.store_generation (shop_id, created_at desc);

create table public.store_generation_proposal (
  run_id     text primary key,
  shop_id    uuid not null references public.shops(id) on delete cascade,
  plan_json  jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.store_settings enable row level security;
alter table public.store_generation enable row level security;
alter table public.store_generation_proposal enable row level security;
create policy store_settings_shop_scope on public.store_settings
  for all using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
create policy store_generation_shop_scope on public.store_generation
  for all using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
create policy store_generation_proposal_shop_scope on public.store_generation_proposal
  for all using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.store_settings from anon, authenticated;
revoke all on table public.store_generation from anon, authenticated;
revoke all on table public.store_generation_proposal from anon, authenticated;
