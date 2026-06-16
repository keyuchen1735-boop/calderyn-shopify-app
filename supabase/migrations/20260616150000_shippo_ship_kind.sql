-- 3PL ship-cost connector, Phase 2: register the Shippo integration kind.
-- integration_kind gates both shop_integrations.kind and integration_credentials.kind.
-- ALTER TYPE ... ADD VALUE is idempotent-guarded with IF NOT EXISTS so re-runs are safe.
-- A freshly-added enum value cannot be USED in the same transaction it is added in
-- (tiktok precedent 20260606120000_tiktok_platform.sql; easypost precedent
-- 20260616140000_easypost_integration_kind.sql) — so this migration adds the value
-- ALONE. No schema delta references the kind here: Phase 2 reuses the Phase-1
-- synthetic-period / source CHECK / external_charge_id machinery unchanged (D1) and
-- only references 'shippo_ship' from later application code.
alter type public.integration_kind add value if not exists 'shippo_ship';
