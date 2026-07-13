-- Campaigns-overhaul action kinds: register the enum values the new code writes.
-- action_audit.action_kind is a Postgres ENUM; inserting an unregistered label
-- throws 22P02 at runtime — and for the first-run wizard that happens AFTER the
-- Meta campaign already exists, surfacing a false failure to the merchant
-- (same failure mode 20260620190000_action_kind_add_increase_budget fixed for
-- autopilot scale-ups).
--
-- 'push_creative_draft' also fixes a LATENT pre-existing gap: the enum only has
-- 'push_creative' (20260609120000), but execute.server.ts's push path inserts
-- action_kind = 'push_creative_draft' — every push-draft audit insert has been
-- rejected by the enum since that path shipped.
--
-- ALTER TYPE ... ADD VALUE is idempotent-guarded with IF NOT EXISTS so re-runs
-- are safe. The v_audit_view change that references 'create_campaign_wizard'
-- lives in the NEXT migration: a new enum value cannot be used in the same
-- transaction that adds it, and each migration runs in its own transaction.
alter type public.action_kind add value if not exists 'update_campaign_budget';
alter type public.action_kind add value if not exists 'duplicate_campaign';
alter type public.action_kind add value if not exists 'create_campaign_wizard';
alter type public.action_kind add value if not exists 'push_creative_draft';
