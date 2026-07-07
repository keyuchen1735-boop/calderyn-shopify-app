-- Retire the bespoke weather_suggestion table. The weather feature now emits
-- weather_demand alerts through the shared alert/deck/calibration spine
-- (upsert_weather_alert RPC), and the old apply/dismiss route + Customers tab
-- were removed. No application code references this table anymore. The per-shop
-- guardrail_config.weather_sensitivity dial is NOT part of this table and stays.
drop table if exists public.weather_suggestion;
