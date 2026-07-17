-- The command-only runtime has no experiment controls and no runtime-0
-- renderer. Close both legacy states in the same deployment that enforces the
-- runtime-1 release pointer guard.

update public.store_experiment
set state = 'stopped',
    decision_note = coalesce(nullif(decision_note, ''), 'Stopped during the runtime-1 storefront cutover'),
    decided_at = coalesce(decided_at, now())
where state = 'running';

create temporary table storefront_runtime1_cutover_targets on commit drop as
select distinct
  page.shop_id,
  release.draft_version_id as previous_draft_version_id,
  release.published_version_id as previous_published_version_id
from public.page_document page
left join public.storefront_release release
  on release.shop_id = page.shop_id
left join public.storefront_bundle_version published
  on published.shop_id = release.shop_id
  and published.id = release.published_version_id
where page.published_json is not null
  and (
    published.id is null
    or published.status <> 'validated'
    or published.schema_version <> 1
    or published.runtime_version <> 1
    or published.validation_profile_version <> 1
    or published.source_kind not in ('recipe', 'custom')
  );

-- A fresh recipe install stores the checked-in bundle byte-for-byte before any
-- merchant override is applied. That makes it a safe, tenant-neutral seed for
-- the rare legacy shop that has no runtime-1 draft at all. Never clone an
-- edited bundle or another merchant's featured-product selection. The pinned
-- hash is storefront_artifact_hash(CUSTOM_BENCH_RECIPE@1) from this release.
create temporary table storefront_runtime1_cutover_seed on commit drop as
select version.*
from public.storefront_bundle_version version
where version.source_kind = 'recipe'
  and version.template_id = 'custom-bench'
  and version.template_version = 1
  and version.status = 'validated'
  and version.schema_version = 1
  and version.runtime_version = 1
  and version.validation_profile_version = 1
  and version.artifact_hash = 'sha256:6422971974cb227fa2b55c4741361310fa5e67de740a94338ad89fd8539b401b'
  and version.artifact_hash = public.storefront_artifact_hash(
    version.schema_version,
    version.runtime_version,
    version.validation_profile_version,
    version.bundle_json,
    version.asset_manifest
  )
  and version.resolution_json #>> '{operation,kind}' = 'initial_design'
  and version.bundle_json #>> '{bundle,source,kind}' = 'recipe'
  and version.bundle_json #>> '{bundle,source,templateId}' = version.template_id
  and case
    when jsonb_typeof(version.bundle_json #> '{bundle,featuredProductIds}') = 'array'
      then jsonb_array_length(version.bundle_json #> '{bundle,featuredProductIds}') = 0
    else version.bundle_json #> '{bundle,featuredProductIds}' is null
  end
order by version.created_at asc, version.id asc
limit 1;

insert into public.storefront_bundle_version (
  shop_id,
  source_kind,
  template_id,
  template_version,
  status,
  schema_version,
  runtime_version,
  validation_profile_version,
  artifact_hash,
  bundle_json,
  asset_manifest,
  validation_report,
  generation_prompt,
  resolution_json
)
select
  target.shop_id,
  seed.source_kind,
  seed.template_id,
  seed.template_version,
  'validated',
  seed.schema_version,
  seed.runtime_version,
  seed.validation_profile_version,
  seed.artifact_hash,
  seed.bundle_json,
  seed.asset_manifest,
  jsonb_build_object(
    'valid', true,
    'cutoverBackfill', jsonb_build_object(
      'reusedValidatedArtifact', true,
      'sourceArtifactHash', seed.artifact_hash
    )
  ),
  'Runtime-1 cutover backfill',
  jsonb_build_object(
    'operation', jsonb_build_object('kind', 'runtime1_cutover_backfill'),
    'sourceArtifactHash', seed.artifact_hash
  )
from storefront_runtime1_cutover_targets target
cross join storefront_runtime1_cutover_seed seed
where not exists (
  select 1
  from public.storefront_bundle_version owned
  where owned.shop_id = target.shop_id
    and owned.status = 'validated'
    and owned.schema_version = 1
    and owned.runtime_version = 1
    and owned.validation_profile_version = 1
    and owned.source_kind in ('recipe', 'custom')
);

create temporary table storefront_runtime1_cutover_versions on commit drop as
select
  target.shop_id,
  target.previous_draft_version_id,
  target.previous_published_version_id,
  selected.id as version_id
from storefront_runtime1_cutover_targets target
join lateral (
  select version.id
  from public.storefront_bundle_version version
  where version.shop_id = target.shop_id
    and version.status = 'validated'
    and version.schema_version = 1
    and version.runtime_version = 1
    and version.validation_profile_version = 1
    and version.source_kind in ('recipe', 'custom')
  order by
    (version.id is not distinct from target.previous_draft_version_id) desc,
    version.created_at desc,
    version.id desc
  limit 1
) selected on true;

insert into public.storefront_release_history (
  shop_id,
  from_version_id,
  to_version_id,
  operation,
  actor_id
)
select
  chosen.shop_id,
  chosen.previous_draft_version_id,
  chosen.version_id,
  'install_draft',
  null
from storefront_runtime1_cutover_versions chosen
where chosen.previous_draft_version_id is distinct from chosen.version_id;

insert into public.storefront_release (
  shop_id,
  draft_version_id,
  published_version_id,
  updated_at
)
select chosen.shop_id, chosen.version_id, chosen.version_id, now()
from storefront_runtime1_cutover_versions chosen
on conflict (shop_id) do update
set draft_version_id = excluded.draft_version_id,
    published_version_id = excluded.published_version_id,
    updated_at = excluded.updated_at;

insert into public.storefront_release_history (
  shop_id,
  from_version_id,
  to_version_id,
  operation,
  actor_id
)
select
  chosen.shop_id,
  chosen.previous_published_version_id,
  chosen.version_id,
  'publish',
  null
from storefront_runtime1_cutover_versions chosen;

do $$
begin
  if exists (
    select 1
    from public.page_document page
    left join public.storefront_release release
      on release.shop_id = page.shop_id
    left join public.storefront_bundle_version published
      on published.shop_id = release.shop_id
      and published.id = release.published_version_id
    where page.published_json is not null
      and (
        published.id is null
        or published.status <> 'validated'
        or published.schema_version <> 1
        or published.runtime_version <> 1
        or published.validation_profile_version <> 1
        or published.source_kind not in ('recipe', 'custom')
      )
  ) then
    raise exception using
      errcode = '55000',
      message = 'runtime1_cutover_backfill_incomplete';
  end if;
end;
$$;
