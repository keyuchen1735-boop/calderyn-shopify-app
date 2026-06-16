-- 3PL ship-cost connector, Phase 1: register the EasyPost integration kind.
-- integration_kind gates both shop_integrations.kind and integration_credentials.kind.
-- ALTER TYPE ... ADD VALUE is idempotent-guarded with IF NOT EXISTS so re-runs are safe.
-- A freshly-added enum value cannot be USED in the same transaction it is added in
-- (tiktok precedent, 20260606120000_tiktok_platform.sql) — so this migration adds the
-- value ALONE; the source CHECK / index / column that *reference* connector rows live in
-- the next migration (20260616140100_ship_cost_connector_source.sql).
alter type public.integration_kind add value if not exists 'easypost_ship';
