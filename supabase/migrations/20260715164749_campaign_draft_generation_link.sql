-- A paid campaign-wizard run owns exactly one resumable campaign draft. Keep
-- the linkage in a typed column instead of searching unindexed JSON so retries,
-- response replays, and later manual saves all converge on the same row.
alter table public.campaign_draft
  add column run_id uuid;

-- Existing complete wizard drafts already carry their run ID in state. If an
-- older client happened to save the same run more than once, link only the most
-- recently updated row and leave the historical duplicate untouched.
with candidates as (
  select
    id,
    (state ->> 'runId')::uuid as run_id,
    row_number() over (
      partition by shop_id, state ->> 'runId'
      order by updated_at desc, created_at desc, id desc
    ) as ordinal
  from public.campaign_draft
  where state ? 'runId'
    and (state ->> 'runId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
)
update public.campaign_draft draft
   set run_id = candidates.run_id
  from candidates
 where draft.id = candidates.id
   and candidates.ordinal = 1;

alter table public.campaign_draft
  add constraint campaign_draft_shop_run_key unique (shop_id, run_id);

create index campaign_draft_shop_updated_idx
  on public.campaign_draft (shop_id, updated_at desc);

comment on column public.campaign_draft.run_id is
  'Stable campaign wizard run. One paid generation run maps to one resumable draft.';
