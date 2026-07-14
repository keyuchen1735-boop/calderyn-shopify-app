create table public.store_policy (
  shop_id uuid not null references public.shops(id) on delete cascade,
  policy_id text not null check (policy_id in ('privacy', 'terms', 'refund', 'shipping')),
  title text not null check (char_length(trim(title)) between 1 and 120),
  body text not null check (char_length(trim(body)) between 1 and 50000),
  updated_at timestamptz not null default now(),
  primary key (shop_id, policy_id)
);

alter table public.store_policy enable row level security;

create policy store_policy_shop_scope on public.store_policy
  for all using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());

revoke all on table public.store_policy from anon, authenticated;
