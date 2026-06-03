create table if not exists public.analytics_settings (
  shop_id uuid primary key references public.shops(id) on delete cascade,
  blended_margin_override numeric,
  updated_at timestamptz not null default now()
);
