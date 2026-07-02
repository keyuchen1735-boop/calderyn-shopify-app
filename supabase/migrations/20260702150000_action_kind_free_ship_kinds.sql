-- Register the two free-shipping action kinds. DETECTOR_TO_ACTIONS maps
-- free_shipping_leakage to raise_free_ship_threshold / exclude_sku_free_ship,
-- and recommendedAction() returns raise_free_ship_threshold for that detector —
-- so a merchant reject of a free-shipping suggestion reaches the enum-typed
-- action_feedback.action_kind column and the calibration_record_rejection RPC
-- param. Without these enum values both writes fail with 22P02, the failure is
-- swallowed (the reject path is deliberately non-throwing), NOTHING is
-- recorded, and — because rejectedAlertIds is derived from action_feedback —
-- the same proposal resurfaces forever (same class of bug as
-- increase_campaign_budget / adjust_price / discontinue_sku). Neither kind has
-- an executor yet, so they remain propose/learn-only; storing the learning
-- signal is exactly why they must be enum members. ALTER TYPE ... ADD VALUE is
-- idempotent-guarded with IF NOT EXISTS.
alter type public.action_kind add value if not exists 'raise_free_ship_threshold';
alter type public.action_kind add value if not exists 'exclude_sku_free_ship';
