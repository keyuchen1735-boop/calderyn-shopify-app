-- Persist the screened creative input (so generation can run from a saved run)
-- and the generated, re-scored variants (only winners that beat the original).
alter table creative_screen_run add column creative_input jsonb;
alter table creative_screen_run add column variants jsonb not null default '[]'::jsonb;

-- Refresh the read view to expose the new columns.
drop view if exists v_creative_screen_runs;
create view v_creative_screen_runs as
  select id, shop_id, status, source, meta_ad_id, mapped_sku_id,
         assumed_spend_cents, scorecard, creative_input, variants, error,
         created_at, completed_at
  from creative_screen_run;
