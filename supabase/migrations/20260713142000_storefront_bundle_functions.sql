-- Transactional release and asset protocol. These functions are invoked only
-- by the server service role; browser roles and PUBLIC are explicitly revoked.

create function public.lock_storefront_design_shop(p_shop_id uuid)
returns void
language sql
security invoker
set search_path = ''
as $$
  select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_shop_id::text, 734821));
$$;

create function public.storefront_artifact_hash(
  p_schema_version integer,
  p_runtime_version integer,
  p_validation_profile_version integer,
  p_bundle_json jsonb,
  p_asset_manifest jsonb
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select 'sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'schemaVersion', p_schema_version,
      'runtimeVersion', p_runtime_version,
      'validationProfileVersion', p_validation_profile_version,
      'artifact', p_bundle_json,
      'assetManifest', p_asset_manifest
    )::text,
    'UTF8'
  )), 'hex');
$$;

create function public.hash_storefront_artifact(
  p_schema_version integer,
  p_runtime_version integer,
  p_validation_profile_version integer,
  p_bundle_json jsonb,
  p_asset_manifest jsonb
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select public.storefront_artifact_hash(
    p_schema_version, p_runtime_version, p_validation_profile_version,
    p_bundle_json, p_asset_manifest
  );
$$;

create function public.storefront_asset_key(p_shop_id uuid, p_content_hash text, p_media_type text)
returns text
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  v_extension text;
begin
  if p_content_hash !~ '^[A-Fa-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_storefront_asset_hash';
  end if;
  v_extension := case p_media_type
    when 'image/png' then 'png'
    when 'image/jpeg' then 'jpg'
    when 'image/webp' then 'webp'
    when 'image/gif' then 'gif'
    when 'image/avif' then 'avif'
    when 'image/svg+xml' then 'svg'
    when 'font/woff2' then 'woff2'
    else null
  end;
  if v_extension is null then
    raise exception using errcode = '22023', message = 'unsupported_storefront_asset_media_type';
  end if;
  return p_shop_id::text || '/storefront/sha256/' || lower(p_content_hash) || '.' || v_extension;
end;
$$;

create function public.storefront_assert_no_running_experiment(p_shop_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform public.lock_storefront_design_shop(p_shop_id);
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

  -- Recipe media ships with the application and is verified against its
  -- checked-in manifest during build. It must never be confused with a
  -- merchant-owned asset object or participate in shop asset GC.
  if v_version.source_kind = 'recipe' then
    if v_reference_count <> 0 then
      raise exception using errcode = '23514', message = 'asset_manifest_mismatch: recipe static asset has shop reference';
    end if;
  elsif v_reference_count <> v_manifest_count or exists (
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
  v_computed_hash text;
begin
  perform public.lock_storefront_design_shop(p_shop_id);
  if p_source_kind = 'legacy' then
    raise exception using errcode = '22023', message = 'legacy_source_requires_capture';
  end if;
  perform public.storefront_assert_no_running_experiment(p_shop_id);
  v_computed_hash := public.storefront_artifact_hash(
    p_schema_version, p_runtime_version, p_validation_profile_version,
    p_bundle_json, p_asset_manifest
  );
  if p_artifact_hash is distinct from v_computed_hash then
    raise exception using errcode = '22000', message = 'storefront_artifact_hash_mismatch';
  end if;
  if p_status = 'validated'
    and p_source_kind <> 'recipe'
    and jsonb_array_length(p_asset_manifest -> 'entries') <> 0 then
    raise exception using errcode = '55000', message = 'validated_bundle_assets_require_candidate_flow';
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
  v_expected_key text;
begin
  perform public.storefront_assert_no_running_experiment(p_shop_id);
  v_expected_key := public.storefront_asset_key(p_shop_id, p_content_hash, p_media_type);
  if p_asset_key is distinct from v_expected_key then
    raise exception using errcode = '22023', message = 'storefront_asset_key_mismatch';
  end if;
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

create function public.validate_storefront_bundle_version(
  p_shop_id uuid,
  p_version_id uuid,
  p_expected_artifact_hash text,
  p_validation_report jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_version public.storefront_bundle_version%rowtype;
  v_computed_hash text;
begin
  perform public.lock_storefront_design_shop(p_shop_id);
  perform public.storefront_assert_no_running_experiment(p_shop_id);
  select * into v_version from public.storefront_bundle_version
    where shop_id = p_shop_id and id = p_version_id for update;
  if not found then
    raise exception using errcode = '23503', message = 'storefront_bundle_not_found';
  end if;
  if v_version.status <> 'candidate' or v_version.source_kind = 'legacy' then
    raise exception using errcode = '55000', message = 'storefront_bundle_not_candidate';
  end if;
  if coalesce((p_validation_report ->> 'valid')::boolean, false) is not true then
    raise exception using errcode = '23514', message = 'storefront_bundle_validation_failed';
  end if;
  v_computed_hash := public.storefront_artifact_hash(
    v_version.schema_version,
    v_version.runtime_version,
    v_version.validation_profile_version,
    v_version.bundle_json,
    v_version.asset_manifest
  );
  if v_version.artifact_hash is distinct from p_expected_artifact_hash
    or v_version.artifact_hash is distinct from v_computed_hash then
    raise exception using errcode = '40001', message = 'storefront_artifact_hash_mismatch';
  end if;
  perform set_config('app.storefront_validate_bundle', '1', true);
  update public.storefront_bundle_version
    set status = 'validated', validation_report = p_validation_report
    where shop_id = p_shop_id and id = p_version_id and status = 'candidate';
  if not found then
    raise exception using errcode = '40001', message = 'storefront_bundle_validation_conflict';
  end if;
  perform public.storefront_assert_installable(p_shop_id, p_version_id);
  return p_version_id;
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
  v_bundle_status text;
begin
  perform public.storefront_assert_no_running_experiment(p_shop_id);
  select status into v_bundle_status from public.storefront_bundle_version
    where shop_id = p_shop_id and id = p_bundle_id for update;
  if not found then
    raise exception using errcode = '23503', message = 'storefront_bundle_not_found';
  end if;
  if v_bundle_status <> 'candidate' then
    raise exception using errcode = '55000', message = 'storefront_asset_reference_requires_candidate';
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

create function public.storefront_bundle_asset_locked_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_bundle_status text;
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.shops where id = old.shop_id) then
    return old;
  end if;
  if tg_op = 'INSERT' then
    select status into v_bundle_status from public.storefront_bundle_version
      where shop_id = new.shop_id and id = new.bundle_id;
    if v_bundle_status <> 'candidate' and coalesce(current_setting('app.storefront_lock_refs', true), '') <> '1' then
      raise exception using errcode = '55000', message = 'storefront_asset_reference_requires_candidate';
    end if;
    return new;
  end if;
  select status into v_bundle_status from public.storefront_bundle_version
    where shop_id = old.shop_id and id = old.bundle_id;
  if old.status = 'locked' then
    raise exception using errcode = '55000', message = 'locked_storefront_bundle_asset_is_immutable';
  end if;
  if v_bundle_status = 'validated'
    and not (
      tg_op = 'UPDATE'
      and new.status = 'locked'
      and coalesce(current_setting('app.storefront_lock_refs', true), '') = '1'
    ) then
    raise exception using errcode = '55000', message = 'validated_storefront_bundle_assets_are_immutable';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if new.status = 'locked' and coalesce(current_setting('app.storefront_lock_refs', true), '') <> '1' then
    raise exception using errcode = '55000', message = 'storefront_asset_lock_requires_release_rpc';
  end if;
  return new;
end;
$$;

create trigger storefront_bundle_asset_locked_guard
before insert or update or delete on public.storefront_bundle_asset
for each row execute function public.storefront_bundle_asset_locked_guard();

create function public.storefront_asset_object_delete_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (select 1 from public.shops where id = old.shop_id) then
    return old;
  end if;
  raise exception using errcode = '55000', message = 'storefront_asset_tombstones_are_immutable';
end;
$$;

create trigger storefront_asset_object_retention_guard
before delete on public.storefront_asset_object
for each row execute function public.storefront_asset_object_delete_guard();

create function public.verify_storefront_asset_gc(
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
  v_valid boolean;
begin
  perform 1 from public.storefront_asset_object
    where shop_id = p_shop_id and asset_key = p_asset_key for update;
  select exists (
    select 1 from public.storefront_asset_object asset
    where asset.shop_id = p_shop_id
      and asset.asset_key = p_asset_key
      and asset.state = 'deleting'
      and asset.generation = p_expected_generation
      and not exists (
        select 1 from public.storefront_bundle_asset ref
        where ref.shop_id = p_shop_id and ref.asset_key = p_asset_key
      )
  ) into v_valid;
  return v_valid;
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

create function public.prepare_storefront_legacy_capture(p_shop_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_existing uuid;
  v_existing_report jsonb;
  v_core jsonb;
  v_snapshot jsonb;
  v_source_assets jsonb;
  v_capture_token text;
begin
  perform public.lock_storefront_design_shop(p_shop_id);
  insert into public.storefront_release (shop_id) values (p_shop_id)
    on conflict (shop_id) do nothing;
  perform 1 from public.storefront_release where shop_id = p_shop_id for update;

  select id, validation_report into v_existing, v_existing_report
    from public.storefront_bundle_version
    where source_kind = 'legacy' and shop_id = p_shop_id
    order by created_at asc limit 1;
  if v_existing is not null then
    if coalesce(v_existing_report ->> 'legacyAdapter', v_existing_report ->> 'legacy_adapter') <> 'validated'
      or coalesce((v_existing_report ->> 'valid')::boolean, false) is not true then
      raise exception using errcode = '55000', message = 'legacy_capture_validation_proof_missing';
    end if;
    return jsonb_build_object('existingVersionId', v_existing);
  end if;

  if (select published_version_id from public.storefront_release where shop_id = p_shop_id) is not null then
    raise exception using errcode = '55000', message = 'legacy_capture_must_precede_bundle_publish';
  end if;

  v_core := jsonb_build_object(
    'pageDocuments', jsonb_build_object(
      'home', (select published_json from public.page_document where shop_id = p_shop_id and page_key = 'home'),
      'collection', (select published_json from public.page_document where shop_id = p_shop_id and page_key = 'collection'),
      'pdp', (select published_json from public.page_document where shop_id = p_shop_id and page_key = 'pdp')
    ),
    'storeSettings', coalesce(
      (select to_jsonb(s) - 'shop_id' - 'updated_at' from public.store_settings s where shop_id = p_shop_id),
      '{}'::jsonb
    )
  );
  v_snapshot := jsonb_build_object(
    'schemaVersion', 1,
    'runtimeVersion', 0,
    'validationProfileVersion', 0,
    'pageDocuments', v_core -> 'pageDocuments',
    'storeSettings', v_core -> 'storeSettings',
    'referencedAssetKeys', '[]'::jsonb,
    'assetAliases', '{}'::jsonb,
    'capturedAt', to_jsonb(clock_timestamp())
  );
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'storageKey', matched.storage_key,
        'publicUrl', matched.public_url,
        'referencedValues', matched.referenced_values
      )
      order by matched.storage_key
    ),
    '[]'::jsonb
  ) into v_source_assets
  from (
    select asset.storage_key, asset.public_url,
      jsonb_agg(distinct value #>> '{}' order by value #>> '{}') as referenced_values
    from public.asset_dim asset
    cross join lateral jsonb_path_query(v_core, '$.** ? (@.type() == "string")') value
    where asset.shop_id = p_shop_id
      and value #>> '{}' in (asset.storage_key, asset.public_url)
    group by asset.storage_key, asset.public_url
  ) matched;
  v_capture_token := 'sha256:' || encode(sha256(convert_to(v_core::text, 'UTF8')), 'hex');
  return jsonb_build_object(
    'snapshot', v_snapshot,
    'sourceAssets', v_source_assets,
    'captureToken', v_capture_token
  );
end;
$$;

create function public.capture_storefront_legacy_release(
  p_shop_id uuid,
  p_actor_id uuid,
  p_snapshot jsonb,
  p_asset_manifest jsonb,
  p_artifact_hash text,
  p_validation_report jsonb,
  p_capture_token text
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_existing uuid;
  v_existing_report jsonb;
  v_core jsonb;
  v_expected_token text;
  v_expected_hash text;
  v_manifest_keys jsonb;
  v_referenced_keys jsonb;
  v_bundle jsonb;
  v_id uuid;
  v_rows integer;
begin
  perform public.lock_storefront_design_shop(p_shop_id);
  insert into public.storefront_release (shop_id) values (p_shop_id)
    on conflict (shop_id) do nothing;
  perform 1 from public.storefront_release where shop_id = p_shop_id for update;

  select id, validation_report into v_existing, v_existing_report
    from public.storefront_bundle_version
    where source_kind = 'legacy' and shop_id = p_shop_id
    order by created_at asc limit 1;
  if v_existing is not null then
    if coalesce(v_existing_report ->> 'legacyAdapter', v_existing_report ->> 'legacy_adapter') <> 'validated'
      or coalesce((v_existing_report ->> 'valid')::boolean, false) is not true then
      raise exception using errcode = '55000', message = 'legacy_capture_validation_proof_missing';
    end if;
    update public.storefront_release
      set published_version_id = v_existing, updated_at = now()
      where shop_id = p_shop_id and published_version_id is null;
    if found and not exists (
      select 1 from public.storefront_release_history
      where shop_id = p_shop_id and to_version_id = v_existing and operation = 'capture_legacy'
    ) then
      insert into public.storefront_release_history (
        shop_id, from_version_id, to_version_id, operation, actor_id
      ) values (p_shop_id, null, v_existing, 'capture_legacy', p_actor_id);
    end if;
    return v_existing;
  end if;

  if (select published_version_id from public.storefront_release where shop_id = p_shop_id) is not null then
    raise exception using errcode = '55000', message = 'legacy_capture_must_precede_bundle_publish';
  end if;

  v_core := jsonb_build_object(
    'pageDocuments', jsonb_build_object(
      'home', (select published_json from public.page_document where shop_id = p_shop_id and page_key = 'home'),
      'collection', (select published_json from public.page_document where shop_id = p_shop_id and page_key = 'collection'),
      'pdp', (select published_json from public.page_document where shop_id = p_shop_id and page_key = 'pdp')
    ),
    'storeSettings', coalesce(
      (select to_jsonb(s) - 'shop_id' - 'updated_at' from public.store_settings s where shop_id = p_shop_id),
      '{}'::jsonb
    )
  );
  v_expected_token := 'sha256:' || encode(sha256(convert_to(v_core::text, 'UTF8')), 'hex');
  if p_capture_token is distinct from v_expected_token
    or p_snapshot -> 'pageDocuments' is distinct from v_core -> 'pageDocuments'
    or p_snapshot -> 'storeSettings' is distinct from v_core -> 'storeSettings'
    or p_snapshot ->> 'schemaVersion' <> '1'
    or p_snapshot ->> 'runtimeVersion' <> '0'
    or p_snapshot ->> 'validationProfileVersion' <> '0' then
    raise exception using errcode = '40001', message = 'legacy_capture_source_changed';
  end if;
  if coalesce((p_validation_report ->> 'valid')::boolean, false) is not true
    or coalesce(p_validation_report ->> 'legacyAdapter', p_validation_report ->> 'legacy_adapter') <> 'validated' then
    raise exception using errcode = '23514', message = 'legacy_capture_validation_proof_missing';
  end if;
  if jsonb_typeof(p_asset_manifest) <> 'object'
    or jsonb_typeof(p_asset_manifest -> 'entries') <> 'array'
    or jsonb_typeof(p_snapshot -> 'referencedAssetKeys') <> 'array'
    or jsonb_typeof(p_snapshot -> 'assetAliases') <> 'object' then
    raise exception using errcode = '23514', message = 'asset_manifest_mismatch';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_asset_manifest -> 'entries') entry
    group by entry ->> 'key' having count(*) > 1
  ) then
    raise exception using errcode = '23514', message = 'asset_manifest_mismatch: duplicate key';
  end if;
  select coalesce(jsonb_agg(entry ->> 'key' order by entry ->> 'key'), '[]'::jsonb)
    into v_manifest_keys from jsonb_array_elements(p_asset_manifest -> 'entries') entry;
  select coalesce(jsonb_agg(value order by value), '[]'::jsonb)
    into v_referenced_keys from jsonb_array_elements_text(p_snapshot -> 'referencedAssetKeys') value;
  if v_referenced_keys is distinct from v_manifest_keys then
    raise exception using errcode = '23514', message = 'asset_manifest_mismatch';
  end if;
  if exists (
    select 1
    from jsonb_each_text(p_snapshot -> 'assetAliases') alias
    where not (v_manifest_keys ? alias.value)
      or not exists (
        select 1 from jsonb_path_query(v_core, '$.** ? (@.type() == "string")') source_value
        where source_value #>> '{}' = alias.key
      )
  ) or exists (
    select 1
    from public.asset_dim asset
    cross join lateral jsonb_path_query(v_core, '$.** ? (@.type() == "string")') source_value
    where asset.shop_id = p_shop_id
      and source_value #>> '{}' in (asset.storage_key, asset.public_url)
      and not (p_snapshot -> 'assetAliases' ? (source_value #>> '{}'))
  ) or exists (
    select 1
    from jsonb_array_elements(p_asset_manifest -> 'entries') entry
    left join public.storefront_asset_object asset
      on asset.shop_id = p_shop_id
      and asset.asset_key = entry ->> 'key'
      and asset.state = 'verified'
      and asset.content_hash = entry ->> 'contentHash'
      and asset.media_type = entry ->> 'mediaType'
      and asset.byte_size = (entry ->> 'byteSize')::bigint
    where asset.asset_key is null
  ) then
    raise exception using errcode = '23514', message = 'asset_manifest_mismatch';
  end if;
  v_bundle := jsonb_build_object('sourceKind', 'legacy', 'snapshot', p_snapshot);
  v_expected_hash := public.storefront_artifact_hash(1, 0, 0, v_bundle, p_asset_manifest);
  if p_artifact_hash is distinct from v_expected_hash then
    raise exception using errcode = '22000', message = 'storefront_artifact_hash_mismatch';
  end if;

  insert into public.storefront_bundle_version (
    shop_id, source_kind, status, schema_version, runtime_version,
    validation_profile_version, artifact_hash, bundle_json, asset_manifest,
    validation_report, resolution_json
  ) values (
    p_shop_id, 'legacy', 'validated', 1, 0, 0,
    p_artifact_hash, v_bundle, p_asset_manifest, p_validation_report,
    jsonb_build_object('kind', 'legacy_capture', 'captureToken', p_capture_token)
  ) returning id into v_id;

  perform set_config('app.storefront_lock_refs', '1', true);
  insert into public.storefront_bundle_asset (shop_id, bundle_id, asset_key, status)
    select p_shop_id, v_id, entry ->> 'key', 'locked'
    from jsonb_array_elements(p_asset_manifest -> 'entries') entry;

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
  perform public.lock_storefront_design_shop(p_shop_id);
  perform public.storefront_assert_no_running_experiment(p_shop_id);
  perform public.storefront_assert_installable(p_shop_id, p_validated_version_id);
  insert into public.storefront_release (shop_id) values (p_shop_id)
    on conflict (shop_id) do nothing;
  perform 1 from public.storefront_release where shop_id = p_shop_id for update;
  perform set_config('app.storefront_lock_refs', '1', true);
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
  perform public.lock_storefront_design_shop(p_shop_id);
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
  perform set_config('app.storefront_lock_refs', '1', true);
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
  p_actor_id uuid,
  p_legacy_snapshot jsonb,
  p_legacy_asset_manifest jsonb,
  p_legacy_artifact_hash text,
  p_legacy_validation_report jsonb,
  p_legacy_capture_token text
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
  perform public.lock_storefront_design_shop(p_shop_id);
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
    v_compare_published := public.capture_storefront_legacy_release(
      p_shop_id,
      p_actor_id,
      p_legacy_snapshot,
      p_legacy_asset_manifest,
      p_legacy_artifact_hash,
      p_legacy_validation_report,
      p_legacy_capture_token
    );
  else
    v_compare_published := p_expected_published_version_id;
  end if;
  if v_current_published is not null and v_current_published is distinct from v_compare_published then
    raise exception using errcode = '40001', message = 'storefront_publish_conflict';
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
  perform public.lock_storefront_design_shop(p_shop_id);
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

create function public.start_store_experiment(
  p_shop_id uuid,
  p_page_key text,
  p_name text,
  p_why text,
  p_variant_doc jsonb,
  p_variant_settings jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.store_experiment%rowtype;
begin
  perform public.lock_storefront_design_shop(p_shop_id);
  if exists (select 1 from public.store_experiment where shop_id = p_shop_id and state = 'running') then
    raise exception using errcode = '23505', message = 'experiment_running';
  end if;
  if exists (
    select 1
    from public.storefront_release release
    join public.storefront_bundle_version version
      on version.shop_id = release.shop_id
      and version.id in (release.draft_version_id, release.published_version_id)
    where release.shop_id = p_shop_id and version.source_kind <> 'legacy'
  ) then
    raise exception using errcode = '55000', message = 'bundle_storefront_active';
  end if;
  insert into public.store_experiment (
    shop_id, page_key, name, why, variant_doc, variant_settings
  ) values (
    p_shop_id, p_page_key, p_name, p_why, p_variant_doc, p_variant_settings
  ) returning * into v_row;
  return to_jsonb(v_row);
end;
$$;

create function public.transition_store_experiment(
  p_shop_id uuid,
  p_experiment_id uuid,
  p_state text,
  p_validated_variant_doc jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.store_experiment%rowtype;
  v_rows integer;
begin
  if p_state not in ('decided_ship', 'decided_keep', 'stopped') then
    raise exception using errcode = '22023', message = 'invalid_experiment_transition';
  end if;
  perform public.lock_storefront_design_shop(p_shop_id);
  select * into v_row from public.store_experiment
    where shop_id = p_shop_id and id = p_experiment_id and state = 'running'
    for update;
  if not found then
    raise exception using errcode = '40001', message = 'experiment_not_running';
  end if;
  if p_state = 'decided_ship' then
    if v_row.variant_settings ->> 'vibe' is not null then
      update public.store_settings
        set vibe = v_row.variant_settings ->> 'vibe', updated_at = now()
        where shop_id = p_shop_id;
      get diagnostics v_rows = row_count;
      if v_rows <> 1 then
        raise exception using errcode = '55000', message = 'experiment_settings_missing';
      end if;
    else
      if p_validated_variant_doc is null then
        raise exception using errcode = '22023', message = 'validated_experiment_document_required';
      end if;
      insert into public.page_document (
        shop_id, page_key, kind, draft_json, published_json, updated_at
      ) values (
        p_shop_id, v_row.page_key, p_validated_variant_doc ->> 'kind',
        p_validated_variant_doc, p_validated_variant_doc, now()
      )
      on conflict (shop_id, page_key) do update
        set kind = excluded.kind,
            draft_json = excluded.draft_json,
            published_json = excluded.published_json,
            updated_at = excluded.updated_at;
    end if;
  end if;
  update public.store_experiment
    set state = p_state, decided_at = now()
    where shop_id = p_shop_id and id = p_experiment_id and state = 'running'
    returning * into v_row;
  if not found then
    raise exception using errcode = '40001', message = 'experiment_not_running';
  end if;
  return to_jsonb(v_row);
end;
$$;

revoke all on function public.lock_storefront_design_shop(uuid) from public, anon, authenticated;
revoke all on function public.storefront_artifact_hash(integer, integer, integer, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.hash_storefront_artifact(integer, integer, integer, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.storefront_asset_key(uuid, text, text) from public, anon, authenticated;
revoke all on function public.storefront_assert_no_running_experiment(uuid) from public, anon, authenticated;
revoke all on function public.storefront_assert_installable(uuid, uuid) from public, anon, authenticated;
revoke all on function public.create_storefront_bundle_version(uuid, text, text, integer, text, integer, integer, integer, text, jsonb, jsonb, jsonb, text, jsonb) from public, anon, authenticated;
revoke all on function public.validate_storefront_bundle_version(uuid, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.record_storefront_verified_asset(uuid, text, text, text, bigint) from public, anon, authenticated;
revoke all on function public.attach_storefront_bundle_asset(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.begin_storefront_asset_gc(uuid, text) from public, anon, authenticated;
revoke all on function public.storefront_bundle_asset_locked_guard() from public, anon, authenticated;
revoke all on function public.storefront_asset_object_delete_guard() from public, anon, authenticated;
revoke all on function public.verify_storefront_asset_gc(uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.finalize_storefront_asset_gc(uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.prepare_storefront_legacy_capture(uuid) from public, anon, authenticated;
revoke all on function public.capture_storefront_legacy_release(uuid, uuid, jsonb, jsonb, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.install_storefront_draft(uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.edit_storefront_draft(uuid, uuid, uuid, uuid, text, text, text, jsonb, jsonb, jsonb, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.publish_storefront_release(uuid, uuid, uuid, uuid, jsonb, jsonb, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.rollback_storefront_release(uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.start_store_experiment(uuid, text, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.transition_store_experiment(uuid, uuid, text, jsonb) from public, anon, authenticated;

grant execute on function public.lock_storefront_design_shop(uuid) to service_role;
grant execute on function public.storefront_artifact_hash(integer, integer, integer, jsonb, jsonb) to service_role;
grant execute on function public.hash_storefront_artifact(integer, integer, integer, jsonb, jsonb) to service_role;
grant execute on function public.storefront_asset_key(uuid, text, text) to service_role;
grant execute on function public.storefront_assert_no_running_experiment(uuid) to service_role;
grant execute on function public.storefront_assert_installable(uuid, uuid) to service_role;
grant execute on function public.create_storefront_bundle_version(uuid, text, text, integer, text, integer, integer, integer, text, jsonb, jsonb, jsonb, text, jsonb) to service_role;
grant execute on function public.validate_storefront_bundle_version(uuid, uuid, text, jsonb) to service_role;
grant execute on function public.record_storefront_verified_asset(uuid, text, text, text, bigint) to service_role;
grant execute on function public.attach_storefront_bundle_asset(uuid, uuid, text) to service_role;
grant execute on function public.begin_storefront_asset_gc(uuid, text) to service_role;
grant execute on function public.storefront_bundle_asset_locked_guard() to service_role;
grant execute on function public.storefront_asset_object_delete_guard() to service_role;
grant execute on function public.verify_storefront_asset_gc(uuid, text, bigint) to service_role;
grant execute on function public.finalize_storefront_asset_gc(uuid, text, bigint) to service_role;
grant execute on function public.prepare_storefront_legacy_capture(uuid) to service_role;
grant execute on function public.capture_storefront_legacy_release(uuid, uuid, jsonb, jsonb, text, jsonb, text) to service_role;
grant execute on function public.install_storefront_draft(uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.edit_storefront_draft(uuid, uuid, uuid, uuid, text, text, text, jsonb, jsonb, jsonb, jsonb, uuid) to service_role;
grant execute on function public.publish_storefront_release(uuid, uuid, uuid, uuid, jsonb, jsonb, text, jsonb, text) to service_role;
grant execute on function public.rollback_storefront_release(uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.start_store_experiment(uuid, text, text, text, jsonb, jsonb) to service_role;
grant execute on function public.transition_store_experiment(uuid, uuid, text, jsonb) to service_role;
