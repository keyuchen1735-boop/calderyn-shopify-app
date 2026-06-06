-- Add `tiktok_ads` to the integration_kind enum so TikTok ad accounts can be
-- stored in integration_credentials / shop_integrations like meta_ads and
-- google_ads. The enum previously held only {shopify, meta_ads, google_ads,
-- quickbooks}; the TikTok OAuth connect flow (app/routes/auth.tiktok.$.tsx)
-- writes credentials with kind = 'tiktok_ads', which would fail without this.
--
-- ADD VALUE IF NOT EXISTS is idempotent and cannot run inside a transaction
-- block in older Postgres; Supabase migrations apply each file in its own
-- statement batch, so this is safe to ship on its own.

alter type public.integration_kind add value if not exists 'tiktok_ads';
