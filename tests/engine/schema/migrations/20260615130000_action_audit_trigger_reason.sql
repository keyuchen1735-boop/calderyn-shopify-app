-- Parity mirror of supabase/migrations/20260615130000_action_audit_trigger_reason.sql.
-- action_audit.trigger_reason: a plain-language note the autopilot writes at
-- execution time. Mirrored here so the later autonomous-undo view
-- (20260621130000_autonomous_undo_window.sql) can select aa.trigger_reason when
-- the parity schema is applied in filename order. The real migration also
-- recreates v_audit_view, but in the parity set that view is first defined at
-- 20260621130000, so only the column is required here.
alter table action_audit add column if not exists trigger_reason text;
