-- Transactional release and asset protocol. These functions are invoked only
-- by the server service role; browser roles and PUBLIC are explicitly revoked.

create function public.storefront_assert_no_running_experiment(p_shop_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.store_experiment
    where shop_id = p_shop_id and state = 'running'
  ) then
    raise exception using errcode = '55000', message = 'storefront_experiment_running';
  end if;
end;
$$;

create function public.storefront_assert_installable(p_shop_id uuid, p_version_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_version public.storefront_bundle_version%rowtype;
  v_manifest_count integer;
  v_reference_count integer;
begin
  select * into v_version
  from public.storefront_bundle_version
  where shop_id = p_shop_id and id = p_version_id
  for update;

  if not found then
    raise exception using errcode = '23503', message = 'storefront_bundle_not_found';
  end if;
  if v_version.status <> 'validated' then
    raise exception using errcode = '23514', message = 'storefront_bundle_not_validated';
  end if;
  if not (
    (v_version.source_kind = 'legacy' and v_version.schema_version = 1 and v_version.runtime_version = 0 and v_version.validation_profile_version = 0)
    or (v_version.source_kind in ('recipe', 'custom') and v_version.schema_version = 1 and v_version.runtime_version = 1 and v_version.validation_profile_version = 1)
  ) then
    raise exception using errcode = '0A000', message = 'unsupported_storefront_bundle_version';
  end if;

  v_manifest_count := jsonb_array_length(v_version.asset_manifest -> 'entries');
  if exists (
    select 1
    from jsonb_array_elements(v_version.asset_manifest -> 'entries') entry
    group by entry ->> 'key'
    having count(*) > 1
  ) then
    raise exception using errcode = '23514', message = 'asset_manifest_mismatch: duplicate key';
  end if;

  select count(*) into v_reference_count
  from public.storefront_bundle_asset
  where shop_id = p_shop_id and bundle_id = p_version_id;

  if v_reference_count <> v_manifest_count or exists (
    select 1
    from jsonb_array_elements(v_version.asset_manifest -> 'entries') entry
    left join public.storefront_bundle_asset ref
      on ref.shop_id = p_shop_id
      and ref.bundle_id = p_version_id
      and ref.asset_key = entry ->> 'key'
      and ref.status in ('verified', 'locked')
    left join public.storefront_asset_object asset
      on asset.shop_id = p_shop_id
      and asset.asset_key = entry ->> 'key'
      and asset.state = 'verified'
      and asset.content_hash = entry ->> 'contentHash'
      and asset.media_type = entry ->> 'mediaType'
      and asset.byte_size = (entry ->> 'byteSize')::bigint
    where ref.asset_key is null or asset.asset_key is null
  ) then
    raise exception using errcode = '23514', message = 'asset_manifest_mismatch';
  end if;
end;
$$;

create function public.create_storefront_bundle_version(
  p_shop_id uuid,
  p_source_kind text,
  p_template_id text,
  p_template_version integer,
  p_status text,
  p_schema_version integer,
  p_runtime_version integer,
  p_validation_profile_version integer,
  p_artifact_hash text,
  p_bundle_json jsonb,
  p_asset_manifest jsonb,
  p_validation_report jsonb,
  p_generation_prompt text,
  p_resolution_json jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_source_kind <> 'legacy' then
    perform public.storefront_assert_no_running_experiment(p_shop_id);
  end if;
  insert into public.storefront_bundle_version (
    shop_id, source_kind, template_id, template_version, status,
    schema_version, runtime_version, validation_profile_version,
    artifact_hash, bundle_json, asset_manifest, validation_report,
    generation_prompt, resolution_json
  ) values (
    p_shop_id, p_source_kind, p_template_id, p_template_version, p_status,
    p_schema_version, p_runtime_version, p_validation_profile_version,
    p_artifact_hash, p_bundle_json, p_asset_manifest, p_validation_report,
    p_generation_prompt, p_resolution_json
  ) returning id into v_id;
  return v_id;
end;
$$;

create function public.record_storefront_verified_asset(
  p_shop_id uuid,
  p_asset_key text,
  p_content_hash text,
  p_media_type text,
  p_byte_size bigint
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_asset public.storefront_asset_object%rowtype;
begin
  perform public.storefront_assert_no_running_experiment(p_shop_id);
  select * into v_asset from public.storefront_asset_object
  where shop_id = p_shop_id and asset_key = p_asset_key
  for update;
  if found then
    if v_asset.content_hash <> p_content_hash
      or v_asset.media_type <> p_media_type
      or v_asset.byte_size <> p_byte_size
      or v_asset.state in ('deleting', 'deleted') then
      raise exception using errcode = '55000', message = 'immutable_storefront_asset_conflict';
    end if;
    update public.storefront_asset_object
      set state = 'verified', updated_at = now()
      where shop_id = p_shop_id and asset_key = p_asset_key;
    return true;
  end if;
  insert into public.storefront_asset_object (
    shop_id, asset_key, content_hash, media_type, byte_size, state
  ) values (p_shop_id, p_asset_key, p_content_hash, p_media_type, p_byte_size, 'verified');
  return true;
end;
$$;

create function public.attach_storefront_bundle_asset(
  p_shop_id uuid,
  p_bundle_id uuid,
  p_asset_key text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_state text;
begin
  perform public.storefront_assert_no_running_experiment(p_shop_id);
  perform 1 from public.storefront_bundle_version
    where shop_id = p_shop_id and id = p_bundle_id for update;
  if not found then
    raise exception using errcode = '23503', message = 'storefront_bundle_not_found';
  end if;
  select state into v_state from public.storefront_asset_object
    where shop_id = p_shop_id and asset_key = p_asset_key for update;
  if not found or v_state <> 'verified' then
    raise exception using errcode = '55000', message = 'storefront_asset_not_verified';
  end if;
  insert into public.storefront_bundle_asset (shop_id, bundle_id, asset_key, status)
    values (p_shop_id, p_bundle_id, p_asset_key, 'verified')
    on conflict (shop_id, bundle_id, asset_key) do nothing;
  return true;
end;
$$;

create function public.begin_storefront_asset_gc(p_shop_id uuid, p_asset_key text)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_generation bigint;
begin
  perform 1 from public.storefront_asset_object
    where shop_id = p_shop_id and asset_key = p_asset_key for update;
  if not found then return null; end if;
  if exists (
    select 1 from public.storefront_bundle_asset
    where shop_id = p_shop_id and asset_key = p_asset_key
  ) then
    raise exception using errcode = '55000', message = 'storefront_asset_still_referenced';
  end if;
  update public.storefront_asset_object
    set state = 'deleting', generation = generation + 1, updated_at = now()
    where shop_id = p_shop_id and asset_key = p_asset_key
      and state in ('staged', 'verified', 'failed')
    returning generation into v_generation;
  return v_generation;
end;
$$;

create function public.finalize_storefront_asset_gc(
  p_shop_id uuid,
  p_asset_key text,
  p_expected_generation bigint
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_rows integer;
begin
  perform 1 from public.storefront_asset_object
    where shop_id = p_shop_id and asset_key = p_asset_key for update;
  update public.storefront_asset_object
    set state = 'deleted', updated_at = now()
    where shop_id = p_shop_id and asset_key = p_asset_key
      and state = 'deleting'
      and generation = p_expected_generation
      and not exists (
        select 1 from public.storefront_bundle_asset
        where shop_id = p_shop_id and asset_key = p_asset_key
      );
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

create function public.capture_storefront_legacy_release(p_shop_id uuid, p_actor_id uuid default null)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_existing uuid;
  v_snapshot jsonb;
  v_referenced_asset_keys jsonb;
  v_bundle jsonb;
  v_id uuid;
  v_rows integer;
begin
  insert into public.storefront_release (shop_id) values (p_shop_id)
    on conflict (shop_id) do nothing;
  perform 1 from public.storefront_release where shop_id = p_shop_id for update;

  select id into v_existing from public.storefront_bundle_version
    where source_kind = 'legacy' and shop_id = p_shop_id
    order by created_at asc limit 1;
  if v_existing is not null then return v_existing; end if;

  if (select published_version_id from public.storefront_release where shop_id = p_shop_id) is not null then
    raise exception using errcode = '55000', message = 'legacy_capture_must_precede_bundle_publish';
  end if;

  v_snapshot := jsonb_build_object(
    'schemaVersion', 1,
    'runtimeVersion', 0,
    'validationProfileVersion', 0,
    'pageDocuments', jsonb_build_object(
      'home', (select published_json from public.page_document where shop_id = p_shop_id and page_key = 'home'),
      'collection', (select published_json from public.page_document where shop_id = p_shop_id and page_key = 'collection'),
      'pdp', (select published_json from public.page_document where shop_id = p_shop_id and page_key = 'pdp')
    ),
    'storeSettings', coalesce(
      (select to_jsonb(s) - 'shop_id' - 'updated_at' from public.store_settings s where shop_id = p_shop_id),
      '{}'::jsonb
    ),
    'referencedAssetKeys', '[]'::jsonb,
    'capturedAt', to_jsonb(clock_timestamp())
  );
  select coalesce(jsonb_agg(asset.storage_key order by asset.storage_key), '[]'::jsonb)
    into v_referenced_asset_keys
    from public.asset_dim asset
    where asset.shop_id = p_shop_id
      and (
        position(asset.storage_key in v_snapshot::text) > 0
        or position(asset.public_url in v_snapshot::text) > 0
      );
  v_snapshot := jsonb_set(v_snapshot, '{referencedAssetKeys}', v_referenced_asset_keys);
  v_bundle := jsonb_build_object('sourceKind', 'legacy', 'snapshot', v_snapshot);

  insert into public.storefront_bundle_version (
    shop_id, source_kind, status, schema_version, runtime_version,
    validation_profile_version, artifact_hash, bundle_json, asset_manifest,
    validation_report, resolution_json
  ) values (
    p_shop_id, 'legacy', 'validated', 1, 0, 0,
    'sha256:' || encode(sha256(convert_to(
      jsonb_build_object('artifact', v_bundle, 'assets', jsonb_build_object('entries', '[]'::jsonb))::text,
      'UTF8'
    )), 'hex'),
    v_bundle, jsonb_build_object('entries', '[]'::jsonb),
    jsonb_build_object('valid', true, 'adapter', 'legacy-runtime-0'),
    jsonb_build_object('kind', 'legacy_capture')
  ) returning id into v_id;

  update public.storefront_release
    set published_version_id = v_id, updated_at = now()
    where shop_id = p_shop_id and published_version_id is null;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception using errcode = '40001', message = 'storefront_publish_conflict';
  end if;
  insert into public.storefront_release_history (
    shop_id, from_version_id, to_version_id, operation, actor_id
  ) values (p_shop_id, null, v_id, 'capture_legacy', p_actor_id);
  return v_id;
end;
$$;

create function public.install_storefront_draft(
  p_shop_id uuid,
  p_validated_version_id uuid,
  p_expected_draft_version_id uuid,
  p_actor_id uuid default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_rows integer;
begin
  perform public.storefront_assert_no_running_experiment(p_shop_id);
  perform public.storefront_assert_installable(p_shop_id, p_validated_version_id);
  insert into public.storefront_release (shop_id) values (p_shop_id)
    on conflict (shop_id) do nothing;
  perform 1 from public.storefront_release where shop_id = p_shop_id for update;
  update public.storefront_bundle_asset
    set status = 'locked'
    where shop_id = p_shop_id and bundle_id = p_validated_version_id and status = 'verified';
  update public.storefront_release
    set draft_version_id = p_validated_version_id, updated_at = now()
    where shop_id = p_shop_id
      and draft_version_id is not distinct from p_expected_draft_version_id;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception using errcode = '40001', message = 'storefront_draft_conflict';
  end if;
  insert into public.storefront_release_history (
    shop_id, from_version_id, to_version_id, operation, actor_id
  ) values (p_shop_id, p_expected_draft_version_id, p_validated_version_id, 'install_draft', p_actor_id);
  return p_validated_version_id;
end;
$$;

create function public.edit_storefront_draft(
  p_shop_id uuid,
  p_base_version_id uuid,
  p_result_version_id uuid,
  p_expected_draft_version_id uuid,
  p_base_artifact_hash text,
  p_result_artifact_hash text,
  p_prompt text,
  p_scope_json jsonb,
  p_patch_json jsonb,
  p_provider_json jsonb,
  p_validation_json jsonb,
  p_actor_id uuid default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_rows integer;
begin
  perform public.storefront_assert_no_running_experiment(p_shop_id);
  if p_base_version_id <> p_expected_draft_version_id then
    raise exception using errcode = '40001', message = 'storefront_edit_conflict';
  end if;
  if not exists (
    select 1 from public.storefront_bundle_version
    where shop_id = p_shop_id and id = p_base_version_id and artifact_hash = p_base_artifact_hash
  ) or not exists (
    select 1 from public.storefront_bundle_version
    where shop_id = p_shop_id and id = p_result_version_id and artifact_hash = p_result_artifact_hash
  ) then
    raise exception using errcode = '40001', message = 'storefront_edit_conflict';
  end if;
  perform public.storefront_assert_installable(p_shop_id, p_result_version_id);
  perform 1 from public.storefront_release where shop_id = p_shop_id for update;
  update public.storefront_bundle_asset
    set status = 'locked'
    where shop_id = p_shop_id and bundle_id = p_result_version_id and status = 'verified';
  update public.storefront_release
    set draft_version_id = p_result_version_id, updated_at = now()
    where shop_id = p_shop_id
      and draft_version_id is not distinct from p_expected_draft_version_id;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception using errcode = '40001', message = 'storefront_edit_conflict';
  end if;
  insert into public.storefront_release_history (
    shop_id, from_version_id, to_version_id, operation, actor_id
  ) values (p_shop_id, p_base_version_id, p_result_version_id, 'edit_draft', p_actor_id);
  insert into public.storefront_bundle_edit (
    shop_id, base_version_id, result_version_id, base_artifact_hash,
    result_artifact_hash, prompt, scope_json, patch_json, provider_json,
    validation_json, actor_id
  ) values (
    p_shop_id, p_base_version_id, p_result_version_id, p_base_artifact_hash,
    p_result_artifact_hash, p_prompt, p_scope_json, p_patch_json, p_provider_json,
    p_validation_json, p_actor_id
  );
  return p_result_version_id;
end;
$$;

create function public.publish_storefront_release(
  p_shop_id uuid,
  p_expected_draft_version_id uuid,
  p_expected_published_version_id uuid,
  p_actor_id uuid default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_current_draft uuid;
  v_current_published uuid;
  v_compare_published uuid;
  v_rows integer;
begin
  perform public.storefront_assert_no_running_experiment(p_shop_id);
  insert into public.storefront_release (shop_id) values (p_shop_id)
    on conflict (shop_id) do nothing;
  select draft_version_id, published_version_id into v_current_draft, v_current_published
    from public.storefront_release where shop_id = p_shop_id for update;
  if v_current_draft is distinct from p_expected_draft_version_id then
    raise exception using errcode = '40001', message = 'storefront_publish_conflict';
  end if;
  if v_current_published is null then
    if p_expected_published_version_id is not null then
      raise exception using errcode = '40001', message = 'storefront_publish_conflict';
    end if;
    v_compare_published := public.capture_storefront_legacy_release(p_shop_id, p_actor_id);
  else
    v_compare_published := p_expected_published_version_id;
  end if;
  perform public.storefront_assert_installable(p_shop_id, p_expected_draft_version_id);
  update public.storefront_release
    set published_version_id = p_expected_draft_version_id, updated_at = now()
    where shop_id = p_shop_id
      and draft_version_id is not distinct from p_expected_draft_version_id
      and published_version_id is not distinct from v_compare_published;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception using errcode = '40001', message = 'storefront_publish_conflict';
  end if;
  insert into public.storefront_release_history (
    shop_id, from_version_id, to_version_id, operation, actor_id
  ) values (p_shop_id, v_compare_published, p_expected_draft_version_id, 'publish', p_actor_id);
  return p_expected_draft_version_id;
end;
$$;

create function public.rollback_storefront_release(
  p_shop_id uuid,
  p_target_version_id uuid,
  p_expected_published_version_id uuid,
  p_actor_id uuid default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_rows integer;
begin
  perform public.storefront_assert_no_running_experiment(p_shop_id);
  perform public.storefront_assert_installable(p_shop_id, p_target_version_id);
  perform 1 from public.storefront_release where shop_id = p_shop_id for update;
  update public.storefront_release
    set published_version_id = p_target_version_id, updated_at = now()
    where shop_id = p_shop_id
      and published_version_id is not distinct from p_expected_published_version_id;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception using errcode = '40001', message = 'storefront_rollback_conflict';
  end if;
  insert into public.storefront_release_history (
    shop_id, from_version_id, to_version_id, operation, actor_id
  ) values (p_shop_id, p_expected_published_version_id, p_target_version_id, 'rollback', p_actor_id);
  return p_target_version_id;
end;
$$;

revoke all on function public.storefront_assert_no_running_experiment(uuid) from public, anon, authenticated;
revoke all on function public.storefront_assert_installable(uuid, uuid) from public, anon, authenticated;
revoke all on function public.create_storefront_bundle_version(uuid, text, text, integer, text, integer, integer, integer, text, jsonb, jsonb, jsonb, text, jsonb) from public, anon, authenticated;
revoke all on function public.record_storefront_verified_asset(uuid, text, text, text, bigint) from public, anon, authenticated;
revoke all on function public.attach_storefront_bundle_asset(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.begin_storefront_asset_gc(uuid, text) from public, anon, authenticated;
revoke all on function public.finalize_storefront_asset_gc(uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.capture_storefront_legacy_release(uuid, uuid) from public, anon, authenticated;
revoke all on function public.install_storefront_draft(uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.edit_storefront_draft(uuid, uuid, uuid, uuid, text, text, text, jsonb, jsonb, jsonb, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.publish_storefront_release(uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.rollback_storefront_release(uuid, uuid, uuid, uuid) from public, anon, authenticated;

grant execute on function public.storefront_assert_no_running_experiment(uuid) to service_role;
grant execute on function public.storefront_assert_installable(uuid, uuid) to service_role;
grant execute on function public.create_storefront_bundle_version(uuid, text, text, integer, text, integer, integer, integer, text, jsonb, jsonb, jsonb, text, jsonb) to service_role;
grant execute on function public.record_storefront_verified_asset(uuid, text, text, text, bigint) to service_role;
grant execute on function public.attach_storefront_bundle_asset(uuid, uuid, text) to service_role;
grant execute on function public.begin_storefront_asset_gc(uuid, text) to service_role;
grant execute on function public.finalize_storefront_asset_gc(uuid, text, bigint) to service_role;
grant execute on function public.capture_storefront_legacy_release(uuid, uuid) to service_role;
grant execute on function public.install_storefront_draft(uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.edit_storefront_draft(uuid, uuid, uuid, uuid, text, text, text, jsonb, jsonb, jsonb, jsonb, uuid) to service_role;
grant execute on function public.publish_storefront_release(uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.rollback_storefront_release(uuid, uuid, uuid, uuid) to service_role;
