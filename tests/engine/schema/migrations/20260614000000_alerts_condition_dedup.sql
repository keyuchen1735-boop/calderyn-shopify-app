-- Alerts: dedupe on the ongoing CONDITION, not the per-day reading.
--
-- Root cause of the alert pile-up: the unique key
--   (shop_id, detector_id, entity_ref, day_bucket)
-- made the engine's ON CONFLICT upsert idempotent only WITHIN a single UTC
-- day. A condition that stays true re-fires every day under a fresh
-- day_bucket, so the engine minted a NEW open alert daily while the prior
-- day's was never resolved — open alerts accumulated one-per-day-per-
-- condition without bound (e.g. one demo shop reached 101 open alerts that
-- were really ~14 distinct problems counted 6 times).
--
-- Fix: an alert is a stateful entity for one ongoing condition. Key the
-- active row on (shop_id, detector_id, entity_ref) via a PARTIAL unique
-- index scoped to non-terminal statuses, so:
--   * a still-true condition refreshes the SAME open/acknowledged/snoozed
--     row (impact, severity, narrative, day_bucket, last_seen_at), and
--   * a condition that recurs AFTER being resolved/dismissed opens a fresh
--     alert (terminal rows sit outside the index).
-- day_bucket stays as a column recording the latest detection day; it is no
-- longer part of the dedup key.

-- 1. Collapse the existing backlog: keep the newest active row per
--    condition, resolve the older duplicates. No-op on a fresh schema.
with ranked as (
  select id,
         row_number() over (
           partition by shop_id, detector_id, entity_ref
           order by day_bucket desc, last_seen_at desc, id desc
         ) as rn
  from alerts
  where status in ('open', 'acknowledged', 'snoozed')
)
update alerts a
   set status = 'resolved',
       resolved_at = now()
  from ranked r
 where a.id = r.id
   and r.rn > 1;

-- 2. Swap the day-bucketed unique key for the condition-scoped partial
--    unique index. DROP CONSTRAINT covers the inline `unique (...)` form;
--    the follow-up DROP INDEX covers any environment where it exists only
--    as a bare unique index.
alter table alerts
  drop constraint if exists alerts_shop_id_detector_id_entity_ref_day_bucket_key;
drop index if exists alerts_shop_id_detector_id_entity_ref_day_bucket_key;

create unique index if not exists alerts_active_condition_key
  on alerts (shop_id, detector_id, entity_ref)
  where status in ('open', 'acknowledged', 'snoozed');
