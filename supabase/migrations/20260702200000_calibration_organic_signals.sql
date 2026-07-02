-- Organic-action learning substrate: Calderyn learns from what the merchant
-- does OUTSIDE it. Two signal kinds, both deterministic:
--
--  1. Implicit approval — the merchant performed the suggested action
--     themselves (e.g. paused the campaign in Meta while our pause suggestion
--     was open). Worth half an explicit click: alpha += 0.5. It moves
--     CONFIDENCE only — clean_approvals and the consecutive streak stay
--     untouched, so implicit signals can never satisfy the explicit-approval
--     graduation bars (spec I3: "clean approval = merchant-approved").
--
--  2. Out-of-band reversal — the merchant reversed an autonomous action on
--     the platform directly (e.g. re-activated a campaign autopilot paused)
--     without using Calderyn's Undo. That is the strongest "you got it wrong"
--     signal there is, and it previously recorded NOTHING. It reuses
--     calibration_record_undo(p_autonomous => true); the new 'reversal'
--     decision value keys its exactly-once ledger row per reversed audit
--     (same dedup machinery as the failure ledger).
--
-- SECURITY DEFINER, search_path='', service_role-only (I9 pattern: revoke from
-- PUBLIC by name — revoking from anon alone leaves the PUBLIC grant).

alter table public.action_feedback drop constraint action_feedback_decision_check;
alter table public.action_feedback add constraint action_feedback_decision_check
  check (decision in ('approve', 'reject', 'failure', 'reversal'));

create or replace function public.calibration_record_implicit_approval(
  p_shop_id uuid,
  p_detector_id text,
  p_action_kind public.action_kind,
  p_alpha_delta numeric default 0.5
) returns void
language sql
security definer
set search_path = ''
as $func$
  insert into public.pair_calibration (shop_id, detector_id, action_kind, alpha, updated_at)
  values (p_shop_id, p_detector_id, p_action_kind, greatest(0, p_alpha_delta), now())
  on conflict (shop_id, detector_id, action_kind) do update
    set alpha = public.pair_calibration.alpha + greatest(0, p_alpha_delta),
        updated_at = now();
$func$;

revoke all on function public.calibration_record_implicit_approval(uuid, text, public.action_kind, numeric) from public;
revoke execute on function public.calibration_record_implicit_approval(uuid, text, public.action_kind, numeric) from anon, authenticated;
grant execute on function public.calibration_record_implicit_approval(uuid, text, public.action_kind, numeric) to service_role;
