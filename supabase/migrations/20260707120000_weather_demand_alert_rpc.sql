-- Canonical weather-alert upsert callable from the TS cron. Mirrors
-- engine/calderyn_engine/alerts_repo.py exactly: the alerts upsert targets the
-- partial unique index alerts_active_condition_key (active statuses only), which
-- PostgREST .upsert() cannot address, so we expose it as a SECURITY DEFINER
-- function the service role calls via sb.rpc(). One alert row + one alert_context
-- row, returning the alert id.
create or replace function public.upsert_weather_alert(
  p_shop_id uuid,
  p_detector_id text,
  p_entity_ref jsonb,
  p_severity text,
  p_dollar_impact numeric,
  p_day_bucket date,
  p_narrative text,
  p_rank int,
  p_evidence jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_alert_id uuid;
begin
  insert into alerts (
    shop_id, detector_id, entity_ref, severity,
    dollar_impact, day_bucket, claude_narrative, claude_rank,
    first_seen_at, last_seen_at
  )
  values (
    p_shop_id, p_detector_id, p_entity_ref, p_severity::alert_severity,
    p_dollar_impact, p_day_bucket, p_narrative, p_rank, now(), now()
  )
  on conflict (shop_id, detector_id, entity_ref)
    where status in ('open','acknowledged','snoozed')
  do update set
    dollar_impact    = excluded.dollar_impact,
    severity         = excluded.severity,
    claude_narrative = excluded.claude_narrative,
    claude_rank      = excluded.claude_rank,
    day_bucket       = excluded.day_bucket,
    last_seen_at     = now(),
    status = case when alerts.status = 'acknowledged'
                  then 'open'::alert_status else alerts.status end
  returning id into v_alert_id;

  insert into alert_context (alert_id, shop_id, evidence)
  values (v_alert_id, p_shop_id, p_evidence)
  on conflict (alert_id) do update set evidence = excluded.evidence;

  return v_alert_id;
end;
$$;

revoke all on function public.upsert_weather_alert(
  uuid, text, jsonb, text, numeric, date, text, int, jsonb
) from public, anon, authenticated;
