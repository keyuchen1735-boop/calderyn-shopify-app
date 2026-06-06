-- Slice 2: attribution. Per-order click-ID breadcrumbs + a confidence stamp on
-- attribution_fact. attribution_method stays a free text column; new values
-- written by the matcher: 'utm_exact' | 'click_id' | 'referrer_host' | 'unknown'.

alter table public.attribution_fact
  add column if not exists confidence text not null default 'none';  -- 'high'|'strong'|'rough'|'none'

create table if not exists public.ad_click_ref (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  order_id    uuid references public.order_fact(id) on delete cascade,
  platform    public.ad_platform,                       -- meta|google|tiktok (null if unknown)
  click_id    text not null,                            -- fbclid / gclid / ttclid value
  utm         jsonb,                                    -- captured utm_* params
  captured_at timestamptz not null default now(),
  unique (order_id, platform, click_id)
);

create index if not exists ad_click_ref_shop_idx on public.ad_click_ref (shop_id, captured_at desc);

alter table public.ad_click_ref enable row level security;

create policy ad_click_ref_read on public.ad_click_ref
  for select using (shop_id = public.current_shop_id());
