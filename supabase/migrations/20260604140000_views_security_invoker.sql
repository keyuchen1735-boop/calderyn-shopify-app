-- Convert the read views from SECURITY DEFINER to security_invoker so they
-- enforce the QUERYING role's RLS instead of the view owner's. Found in the
-- 2026-06-04 security audit: as SECURITY DEFINER, these views bypassed the
-- underlying tables' RLS, so the anon role (which has SELECT on them) could read
-- every shop's data through them — a cross-tenant read path.
--
-- Safe for the app + python engine: both query via the service-role / postgres
-- role (BYPASSRLS), so they are unaffected. The anon/authenticated roles now get
-- RLS-filtered against the base tables (no policy → denied).

alter view public.v_alerts_view     set (security_invoker = on);
alter view public.v_audit_view      set (security_invoker = on);
alter view public.v_campaigns_flat  set (security_invoker = on);
alter view public.v_skus_flat       set (security_invoker = on);
