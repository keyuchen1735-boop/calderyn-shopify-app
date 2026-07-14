-- Preserve immutable asset provenance when prompt edits mint new versions.
-- Deploy-owned recipe assets are pinned independently of merchant objects;
-- custom candidates may inherit either kind only from a validated source.

create table public.storefront_recipe_asset_registry (
  template_id text not null,
  template_version integer not null check (template_version > 0),
  logical_key text not null check (logical_key ~ '^[A-Za-z0-9_-]{1,80}$'),
  content_hash text not null check (content_hash ~ '^[A-Fa-f0-9]{64}$'),
  media_type text not null,
  byte_size bigint not null check (byte_size > 0),
  primary key (template_id, template_version, logical_key)
);

insert into public.storefront_recipe_asset_registry
  (template_id, template_version, logical_key, content_hash, media_type, byte_size)
values
  ('custom-bench', 1, 'hero', 'f6f25c15de46bf6dd431ae685202f90fbbc3ba00e8051f6a6f4afaa8b89cdde9', 'image/webp', 132568),
  ('commons-index', 1, 'hero', '9201028ef1da24dd4318d0dafd8b4e18f32d16e12ba921c5ded28765b0cbaca1', 'image/webp', 130446),
  ('soft-chemistry', 1, 'hero', '4639c3cfe144d901162c2ede0053cd6174e26379460e3d63a3bef64f286f482f', 'image/webp', 40456),
  ('companion-field-guide', 1, 'hero', '305b7c4a9f43578032dba1e95a63869d9e17b370585c24438b7b963aa0a9a2d6', 'image/webp', 158522),
  ('daily-protocol', 1, 'hero', '798fb222ba0b6975c3f83d7d95f6640227f781b2e4582f758cc712a0f45a8054', 'image/webp', 81984),
  ('room-modes', 1, 'hero', 'ed779ae096effacc6af8a58f5ab55b79faad5ae2b3b5fba892b796e310586d30', 'image/webp', 80050),
  ('rep-rest', 1, 'hero', 'b404cf72b60022837096e1e8b02d539b5369a9ff09d4bda742378b7aae71d9c1', 'image/webp', 170844),
  ('diagnostic-deck', 1, 'hero', 'dca1f96a14f60dcc2b1305f84ac97b480f8007a25709ac9995eee71ac8e2db9e', 'image/webp', 101094),
  ('ritual-almanac', 1, 'hero', '747c24090ce37d341af9d22a7057f5830c26dc74181da0d82bb5aa07ffafe8f8', 'image/webp', 242494),
  ('broadcast-patch-bay', 1, 'hero', 'c95d86839d3b7efea39f439452011aaad78e4519e9928890246f67b0bf9f5363', 'image/webp', 78150),
  ('atelier-nine', 1, 'hero', 'bf43ff158ad36f2399f116949983f821578bec4e4bbf7baad34791604ac90fc9', 'image/webp', 44708);

create table public.storefront_bundle_recipe_asset (
  shop_id uuid not null references public.shops(id) on delete cascade,
  bundle_id uuid not null,
  logical_key text not null,
  template_id text not null,
  template_version integer not null,
  created_at timestamptz not null default now(),
  primary key (shop_id, bundle_id, logical_key),
  foreign key (shop_id, bundle_id)
    references public.storefront_bundle_version (shop_id, id) on delete no action deferrable initially deferred,
  foreign key (template_id, template_version, logical_key)
    references public.storefront_recipe_asset_registry (template_id, template_version, logical_key) on delete no action
);

alter table public.storefront_recipe_asset_registry enable row level security;
alter table public.storefront_bundle_recipe_asset enable row level security;
revoke all on table public.storefront_recipe_asset_registry from anon, authenticated;
revoke all on table public.storefront_bundle_recipe_asset from anon, authenticated;
revoke insert, update, delete on table public.storefront_recipe_asset_registry from service_role;
grant select on table public.storefront_recipe_asset_registry to service_role;

create function public.storefront_bundle_recipe_asset_guard()
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
    select status into v_bundle_status
    from public.storefront_bundle_version
    where shop_id = new.shop_id and id = new.bundle_id;
    if v_bundle_status <> 'candidate' then
      raise exception using errcode = '55000', message = 'storefront_recipe_asset_reference_requires_candidate';
    end if;
    return new;
  end if;
  select status into v_bundle_status
  from public.storefront_bundle_version
  where shop_id = old.shop_id and id = old.bundle_id;
  if v_bundle_status = 'validated' then
    raise exception using errcode = '55000', message = 'validated_storefront_recipe_assets_are_immutable';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  raise exception using errcode = '55000', message = 'storefront_recipe_asset_provenance_is_immutable';
end;
$$;

create trigger storefront_bundle_recipe_asset_guard
before insert or update or delete on public.storefront_bundle_recipe_asset
for each row execute function public.storefront_bundle_recipe_asset_guard();

create function public.clone_storefront_bundle_asset_provenance(
  p_shop_id uuid,
  p_source_bundle_id uuid,
  p_target_bundle_id uuid
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_source public.storefront_bundle_version%rowtype;
  v_target public.storefront_bundle_version%rowtype;
begin
  perform public.lock_storefront_design_shop(p_shop_id);
  perform public.storefront_assert_no_running_experiment(p_shop_id);
  select * into v_source from public.storefront_bundle_version
    where shop_id = p_shop_id and id = p_source_bundle_id for update;
  if not found or v_source.status <> 'validated' then
    raise exception using errcode = '55000', message = 'storefront_asset_clone_source_not_validated';
  end if;
  select * into v_target from public.storefront_bundle_version
    where shop_id = p_shop_id and id = p_target_bundle_id for update;
  if not found or v_target.status <> 'candidate' or v_target.source_kind <> 'custom' then
    raise exception using errcode = '55000', message = 'storefront_asset_clone_target_not_custom_candidate';
  end if;

  -- Merchant-owned objects are copied by their verified source reference; the
  -- target manifest must name the same logical key and immutable metadata.
  insert into public.storefront_bundle_asset (shop_id, bundle_id, logical_key, asset_key, status)
  select p_shop_id, p_target_bundle_id, entry ->> 'key', source_ref.asset_key, 'verified'
  from jsonb_array_elements(v_target.asset_manifest -> 'entries') entry
  join public.storefront_bundle_asset source_ref
    on source_ref.shop_id = p_shop_id
    and source_ref.bundle_id = p_source_bundle_id
    and source_ref.logical_key = entry ->> 'key'
    and source_ref.status in ('verified', 'locked')
  join public.storefront_asset_object asset
    on asset.shop_id = p_shop_id
    and asset.asset_key = source_ref.asset_key
    and asset.state = 'verified'
    and asset.content_hash = entry ->> 'contentHash'
    and asset.media_type = entry ->> 'mediaType'
    and asset.byte_size = (entry ->> 'byteSize')::bigint
  on conflict (shop_id, bundle_id, logical_key) do nothing;

  -- A recipe source has no shop object reference. Mint provenance only where
  -- both its frozen manifest and the deployment registry agree exactly.
  if v_source.source_kind = 'recipe' then
    insert into public.storefront_bundle_recipe_asset
      (shop_id, bundle_id, logical_key, template_id, template_version)
    select p_shop_id, p_target_bundle_id, entry ->> 'key', registry.template_id, registry.template_version
    from jsonb_array_elements(v_target.asset_manifest -> 'entries') entry
    join jsonb_array_elements(v_source.asset_manifest -> 'entries') source_entry
      on source_entry ->> 'key' = entry ->> 'key'
      and source_entry ->> 'contentHash' = entry ->> 'contentHash'
      and source_entry ->> 'mediaType' = entry ->> 'mediaType'
      and (source_entry ->> 'byteSize')::bigint = (entry ->> 'byteSize')::bigint
    join public.storefront_recipe_asset_registry registry
      on registry.template_id = v_source.template_id
      and registry.template_version = v_source.template_version
      and registry.logical_key = entry ->> 'key'
      and registry.content_hash = entry ->> 'contentHash'
      and registry.media_type = entry ->> 'mediaType'
      and registry.byte_size = (entry ->> 'byteSize')::bigint
    on conflict (shop_id, bundle_id, logical_key) do nothing;
  else
    insert into public.storefront_bundle_recipe_asset
      (shop_id, bundle_id, logical_key, template_id, template_version)
    select p_shop_id, p_target_bundle_id, entry ->> 'key', source_ref.template_id, source_ref.template_version
    from jsonb_array_elements(v_target.asset_manifest -> 'entries') entry
    join public.storefront_bundle_recipe_asset source_ref
      on source_ref.shop_id = p_shop_id
      and source_ref.bundle_id = p_source_bundle_id
      and source_ref.logical_key = entry ->> 'key'
    join public.storefront_recipe_asset_registry registry
      on registry.template_id = source_ref.template_id
      and registry.template_version = source_ref.template_version
      and registry.logical_key = source_ref.logical_key
      and registry.content_hash = entry ->> 'contentHash'
      and registry.media_type = entry ->> 'mediaType'
      and registry.byte_size = (entry ->> 'byteSize')::bigint
    on conflict (shop_id, bundle_id, logical_key) do nothing;
  end if;

  -- Fail before validation when any inherited manifest entry lacks exactly one
  -- provenance row. Directly attached new assets may already satisfy it.
  if exists (
    select 1
    from jsonb_array_elements(v_target.asset_manifest -> 'entries') entry
    left join public.storefront_bundle_asset target_ref
      on target_ref.shop_id = p_shop_id
      and target_ref.bundle_id = p_target_bundle_id
      and target_ref.logical_key = entry ->> 'key'
      and target_ref.status = 'verified'
    left join public.storefront_bundle_recipe_asset target_recipe_ref
      on target_recipe_ref.shop_id = p_shop_id
      and target_recipe_ref.bundle_id = p_target_bundle_id
      and target_recipe_ref.logical_key = entry ->> 'key'
    where (case when target_ref.logical_key is null then 0 else 1 end)
        + (case when target_recipe_ref.logical_key is null then 0 else 1 end) <> 1
  ) then
    raise exception using errcode = '23514', message = 'asset_manifest_mismatch: inherited provenance incomplete';
  end if;
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
  v_owned_reference_count integer;
  v_recipe_reference_count integer;
begin
  select * into v_version from public.storefront_bundle_version
    where shop_id = p_shop_id and id = p_version_id for update;
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
  select count(*) into v_owned_reference_count from public.storefront_bundle_asset
    where shop_id = p_shop_id and bundle_id = p_version_id;
  select count(*) into v_recipe_reference_count from public.storefront_bundle_recipe_asset
    where shop_id = p_shop_id and bundle_id = p_version_id;

  if v_version.source_kind = 'recipe' then
    if v_owned_reference_count <> 0 or v_recipe_reference_count <> 0 then
      raise exception using errcode = '23514', message = 'asset_manifest_mismatch: recipe source has persisted references';
    end if;
  elsif v_version.source_kind = 'custom' and (
    v_owned_reference_count + v_recipe_reference_count <> v_manifest_count
    or exists (
      select 1
      from jsonb_array_elements(v_version.asset_manifest -> 'entries') entry
      left join public.storefront_bundle_asset owned_ref
        on owned_ref.shop_id = p_shop_id and owned_ref.bundle_id = p_version_id
        and owned_ref.logical_key = entry ->> 'key' and owned_ref.status in ('verified', 'locked')
      left join public.storefront_asset_object asset
        on asset.shop_id = p_shop_id and asset.asset_key = owned_ref.asset_key and asset.state = 'verified'
        and asset.content_hash = entry ->> 'contentHash' and asset.media_type = entry ->> 'mediaType'
        and asset.byte_size = (entry ->> 'byteSize')::bigint
      left join public.storefront_bundle_recipe_asset recipe_ref
        on recipe_ref.shop_id = p_shop_id and recipe_ref.bundle_id = p_version_id
        and recipe_ref.logical_key = entry ->> 'key'
      left join public.storefront_recipe_asset_registry registry
        on registry.template_id = recipe_ref.template_id and registry.template_version = recipe_ref.template_version
        and registry.logical_key = recipe_ref.logical_key
        and registry.content_hash = entry ->> 'contentHash' and registry.media_type = entry ->> 'mediaType'
        and registry.byte_size = (entry ->> 'byteSize')::bigint
      where (case when asset.asset_key is null then 0 else 1 end)
          + (case when registry.logical_key is null then 0 else 1 end) <> 1
    )
  ) then
    raise exception using errcode = '23514', message = 'asset_manifest_mismatch';
  elsif v_version.source_kind = 'legacy' and (
    v_recipe_reference_count <> 0 or v_owned_reference_count <> v_manifest_count or exists (
      select 1
      from jsonb_array_elements(v_version.asset_manifest -> 'entries') entry
      left join public.storefront_bundle_asset ref
        on ref.shop_id = p_shop_id and ref.bundle_id = p_version_id
        and ref.asset_key = entry ->> 'key' and ref.status in ('verified', 'locked')
      left join public.storefront_asset_object asset
        on asset.shop_id = p_shop_id and asset.asset_key = entry ->> 'key' and asset.state = 'verified'
        and asset.content_hash = entry ->> 'contentHash' and asset.media_type = entry ->> 'mediaType'
        and asset.byte_size = (entry ->> 'byteSize')::bigint
      where ref.asset_key is null or asset.asset_key is null
    )
  ) then
    raise exception using errcode = '23514', message = 'asset_manifest_mismatch';
  end if;
end;
$$;

revoke all on function public.storefront_bundle_recipe_asset_guard() from public, anon, authenticated;
revoke all on function public.clone_storefront_bundle_asset_provenance(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.storefront_assert_installable(uuid, uuid) from public, anon, authenticated;
grant execute on function public.storefront_bundle_recipe_asset_guard() to service_role;
grant execute on function public.clone_storefront_bundle_asset_provenance(uuid, uuid, uuid) to service_role;
grant execute on function public.storefront_assert_installable(uuid, uuid) to service_role;
