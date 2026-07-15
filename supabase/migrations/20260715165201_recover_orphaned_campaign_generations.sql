-- Generations created before run-linked auto-save already have permanent image
-- URLs and a complete response in the idempotency ledger. Recover every intact
-- orphan instead of making the merchant pay again. Historical requests did not
-- include placement, so recovered drafts use Facebook as an editable default.
with ranked as (
  select
    attempt.*,
    product.title as product_title,
    row_number() over (
      partition by attempt.shop_id, attempt.run_id
      order by attempt.completed_at desc nulls last, attempt.created_at desc
    ) as ordinal
  from public.campaign_wizard_generation_attempt attempt
  join public.product_dim product
    on product.id = attempt.product_id
   and product.shop_id = attempt.shop_id
  where attempt.result is not null
    and attempt.result ->> 'available' = 'true'
    and jsonb_typeof(attempt.result -> 'variants') = 'array'
    and jsonb_array_length(attempt.result -> 'variants') > 0
    and nullif(attempt.result ->> 'destinationUrl', '') is not null
    and nullif(attempt.result #>> '{variants,0,headline}', '') is not null
    and nullif(attempt.result #>> '{variants,0,primaryText}', '') is not null
    and nullif(attempt.result #>> '{variants,0,cta}', '') is not null
), recoverable as (
  select *
  from ranked
  where ordinal = 1
)
insert into public.campaign_draft (
  shop_id,
  name,
  platform,
  state,
  run_id,
  created_at,
  updated_at
)
select
  recoverable.shop_id,
  recoverable.product_title,
  'meta',
  jsonb_build_object(
    'version', 1,
    'runId', recoverable.run_id::text,
    'placement', 'facebook',
    'productId', recoverable.product_id::text,
    'productTitle', recoverable.product_title,
    'productImageUrl', recoverable.result -> 'imageUrl',
    'budgetCents', 1500,
    'creative', jsonb_build_object(
      'headline', recoverable.result #>> '{variants,0,headline}',
      'primaryText', recoverable.result #>> '{variants,0,primaryText}',
      'cta', recoverable.result #>> '{variants,0,cta}',
      'imageUrl', to_jsonb(coalesce(
        recoverable.result #>> '{variants,0,imageUrl}',
        recoverable.result ->> 'imageUrl'
      )),
      'destinationUrl', recoverable.result ->> 'destinationUrl',
      'audience', 'Broad, your country'
    ),
    'creativeVariants', recoverable.result -> 'variants',
    'selectedCreativeIndex', 0,
    'regenerationsLeft', coalesce(
      (recoverable.result ->> 'regenerationsLeft')::integer,
      2
    )
  ),
  recoverable.run_id,
  coalesce(recoverable.completed_at, recoverable.created_at),
  coalesce(recoverable.completed_at, recoverable.created_at)
from recoverable
where not exists (
  select 1
  from public.campaign_draft draft
  where draft.shop_id = recoverable.shop_id
    and draft.run_id = recoverable.run_id
)
on conflict (shop_id, run_id) do nothing;
