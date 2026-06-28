-- Persist the granted OAuth scopes for an integration so the app can tell
-- whether a Meta token carries ads_management (required to create paused-draft
-- ads) WITHOUT a live Graph call on every render. Populated at the OAuth
-- callback from GET /me/permissions; null on pre-existing rows (treated as no
-- scope by hasAdsManagementScope, so the push button stays safely disabled).
alter table public.integration_credentials
  add column if not exists scopes text;
