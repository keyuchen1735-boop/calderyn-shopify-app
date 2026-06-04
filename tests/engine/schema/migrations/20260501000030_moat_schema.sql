-- Plan 05 Task 1 — moat schema + event_log table.
--
-- Creates the cross-tenant ``moat`` schema and the immutable ``event_log``
-- append-only fact table. Rows here carry a ``pseudonym_id`` (HMAC of
-- shop_id under the active pepper) instead of ``shop_id`` — there is
-- intentionally no shop_id column so a leak of moat rows alone cannot be
-- pinned back to a specific tenant. The pseudonym → shop_id mapping lives
-- in a separate schema (``moat_keys``) under a different DB role.

create schema if not exists moat;

-- One source-of-truth for every event kind the trainer understands. New
-- kinds must be added here AND in packages/shared/src/moat/events.ts AND
-- in apps/engine/calderyn_engine/moat/events.py at the same time so the
-- TS, Python and SQL views agree.
create type moat.event_kind as enum (
  'detection_fired',
  'alert_feedback',
  'action_executed',
  'action_undone',
  'outcome_confirmed',
  'threshold_update'
);

create table moat.event_log (
  id           bigserial primary key,
  pseudonym_id text   not null,
  event_kind   moat.event_kind not null,
  detector_id  text,
  payload      jsonb  not null,
  observed_at  timestamptz not null default now(),
  ingested_at  timestamptz not null default now()
);

-- Three indexes to support the hot read paths:
--   1. trainer aggregations across an event-kind window
--   2. per-pseudonym timeline lookups
--   3. per-detector slicing (detector_id is nullable so partial)
create index event_log_event_kind_observed_at_idx
  on moat.event_log (event_kind, observed_at);
create index event_log_pseudonym_observed_at_idx
  on moat.event_log (pseudonym_id, observed_at);
create index event_log_detector_idx
  on moat.event_log (detector_id) where detector_id is not null;
