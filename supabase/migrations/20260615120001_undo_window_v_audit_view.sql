-- 24-hour undo window in the audit view.
--
-- The "undo" differentiator is a *24-hour* guarantee, but undo_eligible only
-- gated on succeeded / not-an-undo / not-already-undone — never on age. So the
-- UI offered "Undo" on actions of any age, and a late reversal (a stale
-- inventory delta, a long-drifted budget) could fire. undoAction now enforces
-- the window at the API boundary (UNDO_WINDOW_MS in app/lib/actions/undo.server.ts);
-- this mirrors it in the view so the button disappears after 24h instead of
-- showing and then erroring on click. Keep the two windows in sync.
--
-- CREATE OR REPLACE keeps the exact column list/order from the live view; the
-- only change is the trailing `created_at >= now() - 24h` term on undo_eligible.
-- security_invoker is re-asserted so per-shop RLS still applies (20260604140000).
create or replace view public.v_audit_view
  with (security_invoker = on) as
 SELECT aa.id,
    aa.shop_id,
    aa.action_kind::text AS action_kind,
        CASE
            WHEN aa.outcome = ANY (ARRAY['succeeded'::action_outcome, 'failed'::action_outcome]) THEN aa.outcome::text
            ELSE 'failed'::text
        END AS outcome,
    COALESCE(aa.params ->> 'target'::text, aa.params ->> 'campaign_name'::text, aa.params ->> 'sku'::text, aa.params ->> 'campaign_id'::text, aa.params ->> 'sku_id'::text, ''::text) AS target,
    COALESCE(aa.dollar_impact_at_exec, 0::numeric) AS dollar_impact_at_exec,
    COALESCE(aa.pre_state, 'null'::jsonb) AS pre_state,
    COALESCE(aa.post_state, 'null'::jsonb) AS post_state,
    aa.created_at,
    COALESCE(aa.actor_user_id, 'system'::text) AS actor,
    (aa.outcome = 'succeeded'::action_outcome
        AND aa.undo_of IS NULL
        AND NOT (EXISTS ( SELECT 1
           FROM action_audit u
          WHERE u.undo_of = aa.id))
        AND aa.created_at >= (now() - interval '24 hours')) AS undo_eligible,
    aa.alert_id,
    COALESCE(al.detector_id, ''::text) AS detector_id,
    aa.last_error AS failure_reason,
    aa.undo_of,
    aa.trigger_reason,
    aa.params ->> 'sku_id'::text AS param_sku_id,
    aa.params ->> 'platform'::text AS param_platform,
    (((aa.params -> 'po'::text) -> 'lines'::text) -> 0) ->> 'sku'::text AS param_po_sku
   FROM action_audit aa
     LEFT JOIN alerts al ON al.id = aa.alert_id
  ORDER BY aa.created_at DESC;
