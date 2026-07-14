-- Durable redacted compiler runs and one-transaction generated bundle install.

create table public.storefront_generation_run (
  generation_id uuid primary key,
  shop_id uuid not null references public.shops(id) on delete cascade,
  stage text not null check (stage in ('context','concepts','judging','expanding','assets','proofing','installed','failed','cancelled')),
  prompt_hash text not null check (prompt_hash ~ '^sha256:[a-f0-9]{64}$'),
  context_fingerprint text,
  usage_json jsonb not null default '{}'::jsonb,
  detail_json jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table public.storefront_generation_run enable row level security;
revoke all on table public.storefront_generation_run from public, anon, authenticated;
grant select, insert, update, delete on table public.storefront_generation_run to service_role;

create index storefront_generation_run_shop_updated_idx
  on public.storefront_generation_run (shop_id, updated_at desc);

create function public.install_generated_storefront_bundle(
  p_shop_id uuid,
  p_expected_draft_version_id uuid,
  p_actor_id uuid,
  p_schema_version integer,
  p_runtime_version integer,
  p_validation_profile_version integer,
  p_bundle_json jsonb,
  p_asset_manifest jsonb,
  p_validation_report jsonb,
  p_generation_prompt text,
  p_resolution_json jsonb,
  p_asset_references jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_version_id uuid;
  v_hash text;
  v_reference jsonb;
begin
  if coalesce((p_validation_report ->> 'valid')::boolean, false) is not true then
    raise exception using errcode = '23514', message = 'storefront_bundle_validation_failed';
  end if;
  if jsonb_typeof(p_asset_references) <> 'array'
    or jsonb_array_length(p_asset_references) <> jsonb_array_length(p_asset_manifest -> 'entries') then
    raise exception using errcode = '23514', message = 'asset_manifest_mismatch';
  end if;
  v_hash := public.storefront_artifact_hash(
    p_schema_version, p_runtime_version, p_validation_profile_version,
    p_bundle_json, p_asset_manifest
  );
  v_version_id := public.create_storefront_bundle_version(
    p_shop_id, 'custom', null, null, 'candidate',
    p_schema_version, p_runtime_version, p_validation_profile_version,
    v_hash, p_bundle_json, p_asset_manifest, null,
    p_generation_prompt, p_resolution_json
  );
  for v_reference in select value from jsonb_array_elements(p_asset_references)
  loop
    perform public.attach_storefront_bundle_asset(
      p_shop_id, v_version_id,
      v_reference ->> 'logicalKey',
      v_reference ->> 'assetKey'
    );
  end loop;
  perform public.validate_storefront_bundle_version(
    p_shop_id, v_version_id, v_hash, p_validation_report
  );
  perform public.install_storefront_draft(
    p_shop_id, v_version_id, p_expected_draft_version_id, p_actor_id
  );
  return v_version_id;
end;
$$;

revoke all on function public.install_generated_storefront_bundle(uuid, uuid, uuid, integer, integer, integer, jsonb, jsonb, jsonb, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.install_generated_storefront_bundle(uuid, uuid, uuid, integer, integer, integer, jsonb, jsonb, jsonb, text, jsonb, jsonb) to service_role;
