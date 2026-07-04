-- Pre-enable Calderyn's three shipped no-brainer Autopilot pairs.
--
-- The Slice C warm-up added pair_calibration.autonomy_enabled (default false)
-- as a second gate on top of graduation, which also defanged the three
-- no-brainer pairs the calibration spec ships unlocked (§4): a brand-new shop
-- that turned Autopilot ON got zero autonomous protection. Product decision
-- 2026-07-03: the no-brainers are pre-enabled out of the box; the warm-up
-- opt-in continues to apply to every other pair.
--
-- Safety unchanged: the shop-level Autopilot switch, guardrails (bypass forced
-- off for autonomous calls), learned rules, freshness re-checks, the stockout
-- precondition allowlist (I10), undo + execution notifications all still gate
-- every fire. Merchants can switch any of the three off from Live Engine.
--
-- Backfill respects explicit merchant signals: rows that are merchant_disabled
-- or carry an active muted_pair rule stay untouched.

-- Deliberately NOT conditioned on pc.graduated: autonomy_enabled is inert
-- until the live graduation verdict passes, so flipping it on a currently
-- demoted row simply means the protection resumes when the pair re-graduates
-- — the same semantics fresh installs get from the seed. Conditioning on
-- graduated would permanently exclude any shop whose pair happened to be
-- demoted at the moment this ran.
update public.pair_calibration pc
set autonomy_enabled = true,
    updated_at = now()
where pc.action_kind = 'pause_campaign'::public.action_kind
  and pc.detector_id in (
    'sku_stockout_vs_spend',
    'campaign_below_breakeven',
    'negative_unit_economics'
  )
  and not pc.autonomy_enabled
  and not pc.merchant_disabled
  and not exists (
    select 1
    from public.calibration_rule cr
    where cr.shop_id = pc.shop_id
      and cr.detector_id = pc.detector_id
      and cr.action_kind = pc.action_kind
      and cr.rule_kind = 'muted_pair'
      and cr.active
  );
