-- Plan 05 Task 10 — moat.detection_models (per-tenant trained thresholds).
--
-- Holds the latest Bayesian posterior + raw thresholds the threshold
-- trainer (workers/moat-trainer) writes nightly. Keyed by
-- (detector_id, shop_id_pseudonym) so the engine can fetch the
-- override at detect time without re-identifying the tenant — the
-- pseudonym is what the engine already has on hand from the active
-- pepper.
--
-- ``threshold_json`` is the canonical override the engine reads via
-- ``calderyn_engine.thresholds.get_threshold`` (Task 14). Same shape
-- as ``alert_thresholds.threshold_json`` (e.g. ``{"min_spend_usd":
-- 1500}``) so the engine can fall back through both layers without
-- shape-shifting.
--
-- ``posterior_json`` is the trainer's working state ({alpha, beta,
-- last_reward}) — opaque to the engine. The trainer reads + writes
-- this on each iteration; the engine only ever reads
-- ``threshold_json``.
--
-- Composite PK on (detector_id, shop_id_pseudonym) so the trainer
-- ``insert ... on conflict do update`` is a single round-trip. The
-- secondary index on (shop_id_pseudonym, detector_id) covers the
-- engine's "all detectors for this shop" prefetch path.

create table moat.detection_models (
  detector_id        text not null,
  shop_id_pseudonym  text not null,
  threshold_json     jsonb not null,
  posterior_json     jsonb not null,
  updated_at         timestamptz not null default now(),
  primary key (detector_id, shop_id_pseudonym)
);

create index detection_models_pseudonym_detector_idx
  on moat.detection_models (shop_id_pseudonym, detector_id);
