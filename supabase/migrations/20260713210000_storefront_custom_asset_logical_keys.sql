-- Keep compiler-owned logical IDs separate from private content-addressed
-- object keys. Legacy references remain null and retain their original rules.

alter table public.storefront_bundle_asset
  add column logical_key text;

alter table public.storefront_bundle_asset
  add constraint storefront_bundle_asset_logical_key_unique
  unique (shop_id, bundle_id, logical_key);

drop function if exists public.attach_storefront_bundle_asset(uuid, uuid, text);

create function public.attach_storefront_bundle_asset(
  p_shop_id uuid,
  p_bundle_id uuid,
  p_logical_key text,
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
  if p_logical_key !~ '^[A-Za-z0-9_-]{1,80}$' then
    raise exception using errcode = '22023', message = 'invalid_storefront_asset_logical_key';
  end if;
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
  insert into public.storefront_bundle_asset (shop_id, bundle_id, logical_key, asset_key, status)
    values (p_shop_id, p_bundle_id, p_logical_key, p_asset_key, 'verified')
    on conflict (shop_id, bundle_id, logical_key) do nothing;
  return true;
end;
$$;

create or replace function public.storefront_assert_installable(p_shop_id uuid, p_version_id uuid)
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
    select 1 from jsonb_array_elements(v_version.asset_manifest -> 'entries') entry
    group by entry ->> 'key' having count(*) > 1
  ) then
    raise exception using errcode = '23514', message = 'asset_manifest_mismatch: duplicate key';
  end if;

  select count(*) into v_reference_count
  from public.storefront_bundle_asset
  where shop_id = p_shop_id and bundle_id = p_version_id;

  if v_version.source_kind = 'recipe' then
    if v_reference_count <> 0 then
      raise exception using errcode = '23514', message = 'asset_manifest_mismatch: recipe static asset has shop reference';
    end if;
  elsif v_version.source_kind = 'custom' and (
    v_reference_count <> v_manifest_count or exists (
      select 1
      from jsonb_array_elements(v_version.asset_manifest -> 'entries') entry
      left join public.storefront_bundle_asset ref
        on ref.shop_id = p_shop_id
        and ref.bundle_id = p_version_id
        and ref.logical_key = entry ->> 'key'
        and ref.status in ('verified', 'locked')
      left join public.storefront_asset_object asset
        on asset.shop_id = p_shop_id
        and asset.asset_key = ref.asset_key
        and asset.state = 'verified'
        and asset.content_hash = entry ->> 'contentHash'
        and asset.media_type = entry ->> 'mediaType'
        and asset.byte_size = (entry ->> 'byteSize')::bigint
      where ref.asset_key is null or asset.asset_key is null
    )
  ) then
    raise exception using errcode = '23514', message = 'asset_manifest_mismatch';
  elsif v_version.source_kind = 'legacy' and (
    v_reference_count <> v_manifest_count or exists (
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
    )
  ) then
    raise exception using errcode = '23514', message = 'asset_manifest_mismatch';
  end if;
end;
$$;

revoke all on function public.attach_storefront_bundle_asset(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.attach_storefront_bundle_asset(uuid, uuid, text, text) to service_role;
