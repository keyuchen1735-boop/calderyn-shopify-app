-- Autopilot action-learning (spec 2026-06-19 §5, §6, §9). Mirror of
-- moat.detection_models / moat.peer_baselines but for ACTION policy instead of
-- detection thresholds. action_models is keyed by shop_id_pseudonym (invariant
-- A4 — never raw shop identity); action_baselines holds the anonymized,
-- consent-gated, k>=5 peer distribution of WINNING action aggressiveness.
create table if not exists moat.action_models (
  detector_id        text not null,
  action_kind        text not null,
  shop_id_pseudonym  text not null,
  policy_json        jsonb not null,   -- {"mu": 0..1}
  posterior_json     jsonb not null,   -- {alpha,beta,n_events,last_reward,n_peers,seeded_from}
  updated_at         timestamptz not null default now(),
  primary key (detector_id, action_kind, shop_id_pseudonym)
);

create table if not exists moat.action_baselines (
  segment      text not null,
  detector_id  text not null,
  action_kind  text not null,
  p25          numeric not null,
  p50          numeric not null,
  p75          numeric not null,
  n            int not null,            -- distinct contributors; always >= 5 (A3)
  updated_at   timestamptz not null default now(),
  primary key (segment, detector_id, action_kind)
);
