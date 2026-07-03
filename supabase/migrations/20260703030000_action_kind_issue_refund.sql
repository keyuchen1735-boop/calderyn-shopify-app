-- Register the issue_refund action kind (platform pivot #3b). A merchant — or the
-- MCP/autopilot brain — issues a Stripe refund against a Calderyn-owned order as a
-- first-class audited action; the executor (app/lib/actions/refund.server.ts) writes
-- action_audit.action_kind = 'issue_refund'. Without the enum value the audit insert
-- would be rejected AFTER the Stripe refund but BEFORE the audit row (the same class
-- of bug that bit increase_campaign_budget / adjust_price), so register it first.
-- ALTER TYPE ... ADD VALUE is idempotent-guarded with IF NOT EXISTS.
alter type public.action_kind add value if not exists 'issue_refund';
