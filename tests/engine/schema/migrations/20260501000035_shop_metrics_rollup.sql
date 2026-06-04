-- Plan 05 Task 21 — moat.shop_metrics_rollup materialized view.
--
-- Aggregates moat.event_log per (shop_pseudonym, detector_id,
-- week_bucket): one row per week per (pseudonym, detector). The
-- view is the cheapest source for both the threshold trainer
-- (Task 13) and the peer-baseline ETL (Task 16) — they currently
-- read raw event_log rows but switching to this rollup is a
-- transparent perf win.
--
-- Materialized (not regular) view because:
--   * The aggregations span 30 days of data per training cycle.
--   * The trainer + ETL run nightly — staleness up to 24h is fine.
--   * Refresh is cheap relative to the read frequency.
--
-- Refresh schedule: pg-boss cron job declared in
-- ``workers/moat-trainer`` (registered alongside the threshold
-- trainer schedule). A separate ``moat-rollup`` worker would be
-- valid; we put it in moat-trainer because the two share the same
-- event_log scan budget and pg-boss instance.
--
-- The view is built ``WITH NO DATA`` so the migration is fast and
-- the first refresh happens out-of-band; the trainer's bootstrap
-- code calls ``REFRESH MATERIALIZED VIEW`` once on startup.

create materialized view moat.shop_metrics_rollup as
select
  e.pseudonym_id                           as shop_pseudonym,
  e.detector_id,
  date_trunc('week', e.observed_at)        as week_bucket,
  count(*) filter (where e.event_kind = 'detection_fired')
                                           as detection_count,
  count(*) filter (where e.event_kind = 'alert_feedback')
                                           as feedback_count,
  count(*) filter (where e.event_kind = 'action_executed')
                                           as action_count,
  count(*) filter (where e.event_kind = 'outcome_confirmed')
                                           as confirmed_loss_count,
  coalesce(sum(
    case
      when e.event_kind = 'detection_fired'
        then (e.payload->>'dollar_impact')::numeric
      when e.event_kind = 'outcome_confirmed'
        then (e.payload->>'confirmed_loss_usd')::numeric
      else 0
    end
  ), 0)                                    as total_dollar_impact
from moat.event_log e
where e.detector_id is not null
group by e.pseudonym_id, e.detector_id, date_trunc('week', e.observed_at)
with no data;

-- Unique index lets ``refresh materialized view concurrently`` work
-- (postgres requires one to do a non-blocking refresh).
create unique index shop_metrics_rollup_pk_idx
  on moat.shop_metrics_rollup (shop_pseudonym, detector_id, week_bucket);
