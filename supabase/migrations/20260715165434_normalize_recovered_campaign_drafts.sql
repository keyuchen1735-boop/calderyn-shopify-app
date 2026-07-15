-- Legacy generated copy predates the wizard draft's current display limits.
-- Normalize only rows created by the orphan-recovery migration so every one
-- parses as resumable state without changing ordinary merchant-authored drafts.
with normalized as (
  select
    draft.id,
    jsonb_agg(
      jsonb_build_object(
        'headline', left(coalesce(variant.value ->> 'headline', ''), 40),
        'primaryText', left(coalesce(variant.value ->> 'primaryText', ''), 500),
        'cta', left(coalesce(variant.value ->> 'cta', ''), 40),
        'rationale', left(coalesce(variant.value ->> 'rationale', ''), 500),
        'imageUrl', coalesce(variant.value -> 'imageUrl', 'null'::jsonb),
        'imageGenerated', coalesce(
          (variant.value ->> 'imageGenerated')::boolean,
          false
        ),
        'score', coalesce(variant.value -> 'score', 'null'::jsonb)
      )
      order by variant.ordinality
    ) as variants
  from public.campaign_draft draft
  cross join lateral jsonb_array_elements(
    draft.state -> 'creativeVariants'
  ) with ordinality as variant(value, ordinality)
  where draft.run_id is not null
    and exists (
      select 1
      from public.campaign_wizard_generation_attempt attempt
      where attempt.shop_id = draft.shop_id
        and attempt.run_id = draft.run_id
        and coalesce(attempt.completed_at, attempt.created_at) = draft.created_at
    )
  group by draft.id
), patched as (
  select
    draft.id,
    left(draft.name, 120) as name,
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(
              jsonb_set(
                draft.state,
                '{productTitle}',
                to_jsonb(left(draft.state ->> 'productTitle', 200))
              ),
              '{creativeVariants}',
              normalized.variants
            ),
            '{creative,headline}',
            normalized.variants #> '{0,headline}'
          ),
          '{creative,primaryText}',
          normalized.variants #> '{0,primaryText}'
        ),
        '{creative,cta}',
        normalized.variants #> '{0,cta}'
      ),
      '{creative,imageUrl}',
      normalized.variants #> '{0,imageUrl}'
    ) as state
  from public.campaign_draft draft
  join normalized on normalized.id = draft.id
)
update public.campaign_draft draft
   set name = patched.name,
       state = patched.state
  from patched
 where draft.id = patched.id;
