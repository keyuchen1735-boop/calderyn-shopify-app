-- Immutable storefront runtime releases. All application access is through the
-- server service-role repositories and the transactional RPCs defined later.

create table public.storefront_bundle_version (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  source_kind text not null check (source_kind in ('legacy', 'recipe', 'custom')),
  template_id text,
  template_version integer,
  status text not null check (status in ('candidate', 'validated', 'failed')),
  schema_version integer not null check (schema_version >= 1),
  runtime_version integer not null check (runtime_version >= 0),
  validation_profile_version integer not null check (validation_profile_version >= 0),
  artifact_hash text not null check (length(artifact_hash) between 8 and 256),
  bundle_json jsonb not null check (jsonb_typeof(bundle_json) = 'object'),
  asset_manifest jsonb not null check (
    jsonb_typeof(asset_manifest) = 'object'
    and jsonb_typeof(asset_manifest -> 'entries') = 'array'
  ),
  validation_report jsonb,
  generation_prompt text,
  resolution_json jsonb not null check (jsonb_typeof(resolution_json) = 'object'),
  created_at timestamptz not null default now(),
  unique (shop_id, id),
  check (
    (source_kind = 'recipe' and template_id is not null and template_version is not null)
    or (source_kind in ('legacy', 'custom') and template_id is null and template_version is null)
  ),
  check (
    (source_kind = 'legacy' and runtime_version = 0 and validation_profile_version = 0)
    or (source_kind in ('recipe', 'custom') and runtime_version >= 1 and validation_profile_version >= 1)
  ),
  check (status <> 'validated' or validation_report is not null)
);

create index storefront_bundle_version_shop_created_idx
  on public.storefront_bundle_version (shop_id, created_at desc);
create index storefront_bundle_version_shop_hash_idx
  on public.storefront_bundle_version (shop_id, artifact_hash);

create table public.storefront_release (
  shop_id uuid primary key references public.shops(id) on delete cascade,
  draft_version_id uuid,
  published_version_id uuid,
  updated_at timestamptz not null default now(),
  foreign key (shop_id, draft_version_id)
    references public.storefront_bundle_version (shop_id, id),
  foreign key (shop_id, published_version_id)
    references public.storefront_bundle_version (shop_id, id)
);

create table public.storefront_release_history (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  from_version_id uuid,
  to_version_id uuid not null,
  operation text not null check (operation in ('capture_legacy', 'install_draft', 'edit_draft', 'publish', 'rollback')),
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (shop_id, from_version_id)
    references public.storefront_bundle_version (shop_id, id),
  foreign key (shop_id, to_version_id)
    references public.storefront_bundle_version (shop_id, id)
);

create index storefront_release_history_shop_created_idx
  on public.storefront_release_history (shop_id, created_at desc);

create table public.storefront_bundle_edit (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  base_version_id uuid not null,
  result_version_id uuid not null,
  base_artifact_hash text not null,
  result_artifact_hash text not null,
  prompt text not null check (char_length(prompt) between 1 and 4000),
  scope_json jsonb not null check (jsonb_typeof(scope_json) in ('object', 'array')),
  patch_json jsonb not null check (jsonb_typeof(patch_json) in ('object', 'array')),
  provider_json jsonb not null check (jsonb_typeof(provider_json) in ('object', 'array')),
  validation_json jsonb not null check (jsonb_typeof(validation_json) in ('object', 'array')),
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (shop_id, base_version_id)
    references public.storefront_bundle_version (shop_id, id),
  foreign key (shop_id, result_version_id)
    references public.storefront_bundle_version (shop_id, id),
  unique (shop_id, result_version_id)
);

create index storefront_bundle_edit_shop_created_idx
  on public.storefront_bundle_edit (shop_id, created_at desc);

create function public.storefront_reject_validated_bundle_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.status = 'validated' then
    raise exception using errcode = '55000', message = 'validated_storefront_bundle_is_immutable';
  end if;
  return new;
end;
$$;

create trigger storefront_bundle_version_immutable
before update on public.storefront_bundle_version
for each row execute function public.storefront_reject_validated_bundle_mutation();

alter table public.storefront_bundle_version enable row level security;
alter table public.storefront_release enable row level security;
alter table public.storefront_release_history enable row level security;
alter table public.storefront_bundle_edit enable row level security;

revoke all on table public.storefront_bundle_version from anon, authenticated;
revoke all on table public.storefront_release from anon, authenticated;
revoke all on table public.storefront_release_history from anon, authenticated;
revoke all on table public.storefront_bundle_edit from anon, authenticated;
revoke all on function public.storefront_reject_validated_bundle_mutation() from public, anon, authenticated;
grant execute on function public.storefront_reject_validated_bundle_mutation() to service_role;
