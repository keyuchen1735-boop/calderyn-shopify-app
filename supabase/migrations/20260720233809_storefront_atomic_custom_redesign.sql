-- Create, validate, audit, and install a proven custom storefront as one transaction.

create function public.install_storefront_custom_redesign(
  p_shop_id uuid,
  p_base_version_id uuid,
  p_expected_draft_version_id uuid,
  p_actor_id uuid,
  p_schema_version integer,
  p_runtime_version integer,
  p_validation_profile_version integer,
  p_result_artifact_hash text,
  p_bundle_json jsonb,
  p_asset_manifest jsonb,
  p_validation_report jsonb,
  p_generation_prompt text,
  p_resolution_json jsonb,
  p_base_artifact_hash text,
  p_prompt text,
  p_scope_json jsonb,
  p_patch_json jsonb,
  p_provider_json jsonb,
  p_validation_json jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_version_id uuid;
begin
  if p_base_version_id is distinct from p_expected_draft_version_id then
    raise exception using errcode = '40001', message = 'storefront_edit_conflict';
  end if;
  if p_bundle_json ->> 'sourceKind' is distinct from 'custom'
    or jsonb_typeof(p_bundle_json -> 'bundle') is distinct from 'object'
    or p_bundle_json #>> '{bundle,source,kind}' is distinct from 'custom'
    or jsonb_typeof(p_bundle_json -> 'authoring') is distinct from 'object'
    or p_bundle_json #>> '{authoring,source,source,kind}' is distinct from 'custom' then
    raise exception using errcode = '23514', message = 'storefront_custom_artifact_invalid';
  end if;

  v_version_id := public.create_storefront_bundle_version(
    p_shop_id,
    'custom',
    null,
    null,
    'candidate',
    p_schema_version,
    p_runtime_version,
    p_validation_profile_version,
    p_result_artifact_hash,
    p_bundle_json,
    p_asset_manifest,
    null,
    p_generation_prompt,
    p_resolution_json
  );
  perform public.clone_storefront_bundle_asset_provenance(
    p_shop_id,
    p_base_version_id,
    v_version_id
  );
  perform public.validate_storefront_bundle_version(
    p_shop_id,
    v_version_id,
    p_result_artifact_hash,
    p_validation_report
  );
  perform public.edit_storefront_draft(
    p_shop_id,
    p_base_version_id,
    v_version_id,
    p_expected_draft_version_id,
    p_base_artifact_hash,
    p_result_artifact_hash,
    p_prompt,
    p_scope_json,
    p_patch_json,
    p_provider_json,
    p_validation_json,
    p_actor_id
  );
  return v_version_id;
end;
$$;

revoke all on function public.install_storefront_custom_redesign(uuid, uuid, uuid, uuid, integer, integer, integer, text, jsonb, jsonb, jsonb, text, jsonb, text, text, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.install_storefront_custom_redesign(uuid, uuid, uuid, uuid, integer, integer, integer, text, jsonb, jsonb, jsonb, text, jsonb, text, text, jsonb, jsonb, jsonb, jsonb) to service_role;

create function public.restore_storefront_custom_version(
  p_shop_id uuid,
  p_base_version_id uuid,
  p_target_version_id uuid,
  p_expected_draft_version_id uuid,
  p_actor_id uuid,
  p_schema_version integer,
  p_runtime_version integer,
  p_validation_profile_version integer,
  p_target_artifact_hash text,
  p_bundle_json jsonb,
  p_asset_manifest jsonb,
  p_validation_report jsonb,
  p_resolution_json jsonb,
  p_base_artifact_hash text
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_target public.storefront_bundle_version%rowtype;
  v_runtime_bundle jsonb;
  v_version_id uuid;
begin
  if p_base_version_id is distinct from p_expected_draft_version_id then
    raise exception using errcode = '40001', message = 'storefront_edit_conflict';
  end if;
  v_runtime_bundle := case
    when p_bundle_json ? 'bundle' then p_bundle_json -> 'bundle'
    else p_bundle_json
  end;
  if (p_bundle_json ? 'sourceKind' and p_bundle_json ->> 'sourceKind' is distinct from 'custom')
    or jsonb_typeof(v_runtime_bundle) is distinct from 'object'
    or v_runtime_bundle #>> '{source,kind}' is distinct from 'custom' then
    raise exception using errcode = '23514', message = 'storefront_custom_restore_artifact_invalid';
  end if;

  perform public.lock_storefront_design_shop(p_shop_id);
  select * into v_target
  from public.storefront_bundle_version
  where shop_id = p_shop_id
    and id = p_target_version_id
    and source_kind = 'custom'
    and status = 'validated'
    and artifact_hash = p_target_artifact_hash
    and schema_version = p_schema_version
    and runtime_version = p_runtime_version
    and validation_profile_version = p_validation_profile_version
    and bundle_json = p_bundle_json
    and asset_manifest = p_asset_manifest
  for update;
  if not found then
    raise exception using errcode = '23514', message = 'storefront_custom_restore_target_invalid';
  end if;

  v_version_id := public.create_storefront_bundle_version(
    p_shop_id,
    'custom',
    null,
    null,
    'candidate',
    p_schema_version,
    p_runtime_version,
    p_validation_profile_version,
    p_target_artifact_hash,
    p_bundle_json,
    p_asset_manifest,
    null,
    'Undo storefront edit',
    p_resolution_json
  );
  perform public.clone_storefront_bundle_asset_provenance(
    p_shop_id,
    p_target_version_id,
    v_version_id
  );
  perform public.validate_storefront_bundle_version(
    p_shop_id,
    v_version_id,
    p_target_artifact_hash,
    p_validation_report
  );
  perform public.edit_storefront_draft(
    p_shop_id,
    p_base_version_id,
    v_version_id,
    p_expected_draft_version_id,
    p_base_artifact_hash,
    p_target_artifact_hash,
    'Undo storefront edit',
    jsonb_build_object('kind', 'undo', 'restoredVersionId', p_target_version_id),
    jsonb_build_object('operations', jsonb_build_array(
      jsonb_build_object('kind', 'restoreVersion', 'versionId', p_target_version_id)
    )),
    jsonb_build_object('kind', 'deterministic', 'model', null),
    p_validation_report,
    p_actor_id
  );
  return v_version_id;
end;
$$;

revoke all on function public.restore_storefront_custom_version(uuid, uuid, uuid, uuid, uuid, integer, integer, integer, text, jsonb, jsonb, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.restore_storefront_custom_version(uuid, uuid, uuid, uuid, uuid, integer, integer, integer, text, jsonb, jsonb, jsonb, jsonb, text) to service_role;
