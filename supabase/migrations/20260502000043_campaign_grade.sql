-- Per-campaign performance grade, computed by the Python engine (Decimal rule
-- math). The engine writes this shop-scoped, so it gets a read+write policy via
-- current_shop_id().

create table public.campaign_grade_fact (
  id              uuid primary key default gen_random_uuid(),
  shop_id         uuid not null references public.shops(id) on delete cascade,
  campaign_id     uuid not null references public.ad_campaign_dim(id) on delete cascade,
  day_bucket      date not null,
  window_days     integer not null default 7,
  grade           text not null,                 -- 'winning' | 'okay' | 'poor'
  roas            numeric(12,4) not null default 0,
  break_even_roas numeric(12,4) not null default 0,
  margin          numeric(6,4) not null default 0,
  confidence      text not null,                 -- 'override' | 'ok' | 'default'
  spend_cents     bigint not null default 0,
  revenue_cents   bigint not null default 0,
  cogs_cents      bigint not null default 0,
  computed_at     timestamptz not null default now(),
  unique (campaign_id, day_bucket)
);

create index campaign_grade_shop_day_idx on public.campaign_grade_fact (shop_id, day_bucket desc);

alter table public.campaign_grade_fact enable row level security;

create policy campaign_grade_scope on public.campaign_grade_fact
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
