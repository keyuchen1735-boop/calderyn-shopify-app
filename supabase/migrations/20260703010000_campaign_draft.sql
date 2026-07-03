-- campaign_draft: merchant-authored campaign drafts created from the dashboard's
-- Create-campaign screen. A draft is an owned record only — nothing is pushed to
-- an ad platform until the merchant launches it there; the Campaigns list renders
-- drafts alongside synced campaigns with no spend/ROAS/score (none exists yet).
--
-- Hardened-migration pattern, identical to order_spine (20260629110000): the table
-- carries its OWN shop_id; RLS `for all` with BOTH using + with check against
-- current_shop_id(); anon/authenticated grants revoked. `unique (shop_id, id)` is
-- the composite-FK target for any future child rows (draft creatives/budgets), so
-- a child can never attach to a draft whose shop_id disagrees with its own.

create table public.campaign_draft (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references public.shops(id) on delete cascade,
  name       text not null,
  platform   text not null check (platform in ('meta','google','tiktok')),
  created_at timestamptz not null default now(),
  unique (shop_id, id)
);
create index campaign_draft_shop_idx on public.campaign_draft (shop_id, created_at desc);

alter table public.campaign_draft enable row level security;
create policy campaign_draft_shop_scope on public.campaign_draft
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.campaign_draft from anon, authenticated;
