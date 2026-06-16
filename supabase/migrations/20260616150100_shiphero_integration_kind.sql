-- 3PL ship-cost connector, Phase 3 (Part B): register the ShipHero integration kind.
-- integration_kind gates both shop_integrations.kind and integration_credentials.kind.
-- ALTER TYPE ... ADD VALUE is idempotent-guarded with IF NOT EXISTS so re-runs are safe.
-- A freshly-added enum value cannot be USED in the same transaction it is added in
-- (tiktok / easypost precedents) — so this migration adds the value ALONE, in its own
-- step, separate from the shipbob_ship ADD VALUE (20260616150000).
-- ShipHero connects via per-merchant OAuth 2.0 (token + refresh) against the GraphQL
-- endpoint (contract C8 / Plan 03 B.3, like Shippo). Credentials land encrypted in
-- integration_credentials.access_token_encrypted. Name follows C9 (<provider>_ship).
alter type public.integration_kind add value if not exists 'shiphero_ship';
