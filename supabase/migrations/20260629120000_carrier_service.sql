-- CarrierService registration (#6.4): one row per shop recording the Shopify
-- CarrierService we registered + the per-shop secret token embedded in its
-- callback URL. App-owned warehouse table (service-role writes; NOT read by the
-- Python engine -> supabase/migrations only, no engine mirror).
--
-- AUTHENTICATION NOTE (security-critical): the rate callback is a PUBLIC endpoint
-- Shopify POSTs at checkout. Shopify does NOT HMAC-sign CarrierService callbacks
-- the way it signs webhooks -- the 2025-07 CarrierService reference documents the
-- callback URL as a plain public POST endpoint with no signature header. So the
-- high-entropy per-shop `callback_token` embedded in the URL path IS the
-- authenticator: an inbound callback whose token resolves to no active row is
-- rejected fail-closed (no rates leaked -> no rate oracle / checkout spoof). The
-- token doubles as the shop resolver (token -> shop_id) so the callback needs no
-- session. Tokens are 256-bit random; the unique index makes lookup O(1).
--
-- RLS mirrors shop_settings / integration_credentials: the app reaches this only
-- via the service-role key (BYPASSRLS); deny-all to anon/authenticated, with a
-- current_shop_id() policy (using + with check) as defense-in-depth.
create table if not exists public.ship_carrier_service_registration (
  shop_id              uuid primary key references public.shops(id) on delete cascade,
  carrier_service_gid  text not null,
  callback_token       text not null,
  callback_url         text not null,
  active               boolean not null default true,
  registered_at        timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (callback_token)
);

alter table public.ship_carrier_service_registration enable row level security;
revoke all on table public.ship_carrier_service_registration from anon, authenticated;
create policy ship_carrier_service_rls on public.ship_carrier_service_registration
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
