-- Autopilot scale-up fix: register the increase_campaign_budget action kind.
-- The scale feature (autopilot_scale_guardrails / autopilot_candidates_add_scale)
-- shipped the candidate view + guardrail caps and the code writes
-- action_audit.action_kind = 'increase_campaign_budget', but the action_kind enum
-- was never extended to include it. Every autopilot scale insert was rejected by
-- the enum and threw out of executeAction AFTER the platform call but BEFORE the
-- audit row was written — surfacing as "couldn't act on" with no audit trail.
-- ALTER TYPE ... ADD VALUE is idempotent-guarded with IF NOT EXISTS so re-runs are safe.
alter type public.action_kind add value if not exists 'increase_campaign_budget';
