-- Outcome-gated autonomy: persist per-action reward outcomes and a per-pair tally.
-- net_positive_outcomes = (positive measured outcomes) - (negative), floored at 0,
-- recomputed nightly from closed-window action_audit rewards. last_outcome_sign is
-- the sign of the most recently closed outcome (-1/0/1), used for demotion.
alter table public.pair_calibration
  add column if not exists net_positive_outcomes integer not null default 0,
  add column if not exists last_outcome_sign smallint not null default 0;

-- Per-action reward: written by the nightly engine pass ONCE the action's per-kind
-- confirmation window has elapsed. reward_signal is the signed Decimal from
-- compute_action_reward; reward_window_closed_at marks when it became countable.
alter table public.action_audit
  add column if not exists reward_signal numeric(12,2),
  add column if not exists reward_window_closed_at timestamptz;

-- Index the closed-window lookups the calibration recompute does per shop.
create index if not exists action_audit_reward_closed_idx
  on public.action_audit (shop_id, action_kind, reward_window_closed_at)
  where reward_window_closed_at is not null;
