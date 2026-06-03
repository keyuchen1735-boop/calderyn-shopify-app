-- Campaign-level daily spend fact: ensure analytics columns + idempotency key.
-- Verify-and-add only what is absent (the table exists for seed data).
-- NOTE (Task 0 reconciliation): confirm the real ad_spend_fact column names
-- against the remote schema before applying; adjust the ADD COLUMNs to match.
alter table public.ad_spend_fact add column if not exists campaign_external_id text;
alter table public.ad_spend_fact add column if not exists day_bucket date;
alter table public.ad_spend_fact add column if not exists spend_cents bigint not null default 0;
alter table public.ad_spend_fact add column if not exists impressions bigint not null default 0;
alter table public.ad_spend_fact add column if not exists link_clicks bigint not null default 0;
alter table public.ad_spend_fact add column if not exists purchases bigint not null default 0;
alter table public.ad_spend_fact add column if not exists purchase_value_cents bigint not null default 0;
alter table public.ad_spend_fact add column if not exists currency text not null default 'USD';

create unique index if not exists ad_spend_fact_shop_campaign_day_uniq
  on public.ad_spend_fact (shop_id, campaign_external_id, day_bucket);
