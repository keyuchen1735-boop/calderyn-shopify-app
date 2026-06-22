-- Register the adjust_price action kind. The price-remediation feature lets a
-- merchant raise a SKU's selling price to restore its pre-erosion margin
-- (margin_erosion / cogs_drift alerts); the executor writes
-- action_audit.action_kind = 'adjust_price'. Without the enum value every
-- insert would be rejected AFTER the Shopify mutation but BEFORE the audit row
-- (the same class of bug that bit increase_campaign_budget), so register it
-- first. adjust_price is confirm-only (never autopilot) — this migration only
-- widens the enum; gating lives in the executor + remediation layer.
-- ALTER TYPE ... ADD VALUE is idempotent-guarded with IF NOT EXISTS.
alter type public.action_kind add value if not exists 'adjust_price';
