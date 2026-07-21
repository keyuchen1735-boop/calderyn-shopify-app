#!/usr/bin/env bash

set -euo pipefail

container="calderyn-storefront-redesign-atomic-$$"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --rm -d \
  --name "$container" \
  -e POSTGRES_PASSWORD=postgres \
  postgres:17-alpine >/dev/null

for _ in {1..30}; do
  if docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$container" pg_isready -U postgres >/dev/null

docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null <<'SQL'
create extension if not exists pgcrypto;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;

create table public.shops (id uuid primary key);
create table public.storefront_bundle_version (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id),
  source_kind text not null,
  template_id text,
  template_version integer,
  status text not null,
  schema_version integer not null,
  runtime_version integer not null,
  validation_profile_version integer not null,
  artifact_hash text not null,
  bundle_json jsonb not null,
  asset_manifest jsonb not null,
  validation_report jsonb,
  generation_prompt text,
  resolution_json jsonb not null,
  created_at timestamptz not null default now(),
  unique (shop_id, id)
);
create table public.storefront_release (
  shop_id uuid primary key references public.shops(id),
  draft_version_id uuid,
  published_version_id uuid,
  updated_at timestamptz not null default now()
);
create table public.storefront_release_history (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null,
  from_version_id uuid,
  to_version_id uuid not null,
  operation text not null,
  actor_id uuid,
  created_at timestamptz not null default now()
);
create table public.storefront_bundle_edit (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null,
  base_version_id uuid not null,
  result_version_id uuid not null,
  base_artifact_hash text not null,
  result_artifact_hash text not null,
  prompt text not null constraint storefront_bundle_edit_prompt_check check (char_length(prompt) between 1 and 4000),
  scope_json jsonb not null,
  patch_json jsonb not null,
  provider_json jsonb not null,
  validation_json jsonb not null,
  actor_id uuid,
  created_at timestamptz not null default now(),
  unique (shop_id, result_version_id)
);
create table public.storefront_asset_object (
  shop_id uuid not null,
  asset_key text not null,
  content_hash text not null,
  media_type text not null,
  byte_size bigint not null,
  state text not null,
  primary key (shop_id, asset_key)
);
create table public.storefront_bundle_asset (
  shop_id uuid not null,
  bundle_id uuid not null,
  logical_key text not null,
  asset_key text not null,
  status text not null,
  unique (shop_id, bundle_id, logical_key)
);
create table public.storefront_recipe_asset_registry (
  template_id text not null,
  template_version integer not null,
  logical_key text not null,
  content_hash text not null,
  media_type text not null,
  byte_size bigint not null,
  primary key (template_id, template_version, logical_key)
);
create table public.storefront_bundle_recipe_asset (
  shop_id uuid not null,
  bundle_id uuid not null,
  logical_key text not null,
  template_id text not null,
  template_version integer not null,
  unique (shop_id, bundle_id, logical_key)
);

create function public.lock_storefront_design_shop(uuid) returns void language sql as 'select';
create function public.storefront_assert_no_running_experiment(uuid) returns void language sql as 'select';
create function public.storefront_assert_installable(uuid, uuid) returns void language sql as 'select';
create function public.storefront_artifact_hash(integer, integer, integer, jsonb, jsonb)
returns text language sql immutable as 'select ''sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb''::text';
SQL

apply_function() {
  local file="$1"
  local name="$2"
  awk -v start="create function public.${name}(" \
    'index($0, start) == 1 { copying = 1 } copying { print } copying && $0 == "$$;" { exit }' \
    "$file" | docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null
}

functions="supabase/migrations/20260713142000_storefront_bundle_functions.sql"
provenance="supabase/migrations/20260713220000_storefront_edit_asset_provenance.sql"
apply_function "$functions" create_storefront_bundle_version
apply_function "$functions" validate_storefront_bundle_version
apply_function "$provenance" clone_storefront_bundle_asset_provenance
apply_function "$functions" edit_storefront_draft
docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  < supabase/migrations/20260720233809_storefront_atomic_custom_redesign.sql >/dev/null

docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null <<'SQL'
grant usage on schema public to service_role;
grant select, insert, update on public.storefront_bundle_version to service_role;
grant select, update on public.storefront_release to service_role;
grant insert on public.storefront_release_history, public.storefront_bundle_edit to service_role;
grant select on public.storefront_asset_object, public.storefront_recipe_asset_registry to service_role;
grant select, insert, update on public.storefront_bundle_asset to service_role;
grant select, insert on public.storefront_bundle_recipe_asset to service_role;
grant execute on function public.lock_storefront_design_shop(uuid) to service_role;
grant execute on function public.storefront_assert_no_running_experiment(uuid) to service_role;
grant execute on function public.storefront_assert_installable(uuid, uuid) to service_role;
grant execute on function public.storefront_artifact_hash(integer, integer, integer, jsonb, jsonb) to service_role;
grant execute on function public.create_storefront_bundle_version(uuid, text, text, integer, text, integer, integer, integer, text, jsonb, jsonb, jsonb, text, jsonb) to service_role;
grant execute on function public.validate_storefront_bundle_version(uuid, uuid, text, jsonb) to service_role;
grant execute on function public.clone_storefront_bundle_asset_provenance(uuid, uuid, uuid) to service_role;
grant execute on function public.edit_storefront_draft(uuid, uuid, uuid, uuid, text, text, text, jsonb, jsonb, jsonb, jsonb, uuid) to service_role;
SQL

docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null <<'SQL'
insert into public.shops(id) values ('11111111-1111-1111-1111-111111111111');
insert into public.storefront_bundle_version (
  id, shop_id, source_kind, status, schema_version, runtime_version,
  validation_profile_version, artifact_hash, bundle_json, asset_manifest,
  validation_report, resolution_json
) values
  (
    '22222222-2222-2222-2222-222222222222',
    '11111111-1111-1111-1111-111111111111',
    'custom', 'validated', 1, 1, 1,
    'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    '{"bundle":{"source":{"kind":"custom"},"schemaVersion":1,"runtimeVersion":1,"validationProfileVersion":1,"assets":{"entries":[{"key":"owned_hero","contentHash":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","mediaType":"image/webp","byteSize":100},{"key":"recipe_hero","contentHash":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","mediaType":"image/webp","byteSize":200}]}}}',
    '{"entries":[{"key":"owned_hero","contentHash":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","mediaType":"image/webp","byteSize":100},{"key":"recipe_hero","contentHash":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","mediaType":"image/webp","byteSize":200}]}',
    '{"valid":true}', '{}'
  ),
  (
    '33333333-3333-3333-3333-333333333333',
    '11111111-1111-1111-1111-111111111111',
    'custom', 'validated', 1, 1, 1,
    'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    '{"sourceKind":"custom"}', '{"entries":[]}', '{"valid":true}', '{}'
  );
insert into public.storefront_asset_object
  (shop_id, asset_key, content_hash, media_type, byte_size, state)
values (
  '11111111-1111-1111-1111-111111111111', 'asset-owned-hero',
  'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  'image/webp', 100, 'verified'
);
insert into public.storefront_bundle_asset
  (shop_id, bundle_id, logical_key, asset_key, status)
values (
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  'owned_hero', 'asset-owned-hero', 'locked'
);
insert into public.storefront_recipe_asset_registry
  (template_id, template_version, logical_key, content_hash, media_type, byte_size)
values (
  'custom-bench', 1, 'recipe_hero',
  'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  'image/webp', 200
);
insert into public.storefront_bundle_recipe_asset
  (shop_id, bundle_id, logical_key, template_id, template_version)
values (
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  'recipe_hero', 'custom-bench', 1
);
insert into public.storefront_release(shop_id, draft_version_id)
values ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333');
SQL

call_sql="set role service_role;
select public.install_storefront_custom_redesign(
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  '22222222-2222-2222-2222-222222222222',
  null, 1, 1, 1,
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  '{\"sourceKind\":\"custom\",\"bundle\":{\"source\":{\"kind\":\"custom\"}},\"authoring\":{\"source\":{\"source\":{\"kind\":\"custom\"}}}}',
  '{\"entries\":[{\"key\":\"owned_hero\",\"contentHash\":\"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\",\"mediaType\":\"image/webp\",\"byteSize\":100},{\"key\":\"recipe_hero\",\"contentHash\":\"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\",\"mediaType\":\"image/webp\",\"byteSize\":200}]}',
  '{\"valid\":true}', 'redesign', '{}',
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'redesign', '{}', '{}', '{}', '{}'
);"

set +e
stale_output="$(docker exec "$container" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c "$call_sql" 2>&1)"
stale_status=$?
set -e
test "$stale_status" -ne 0
test "${stale_output#*storefront_edit_conflict}" != "$stale_output"

state="$(docker exec "$container" psql -At -F '|' -U postgres -d postgres -c "
  select
    (select count(*) from public.storefront_bundle_version),
    (select count(*) from public.storefront_bundle_edit),
    (select count(*) from public.storefront_release_history),
    (select draft_version_id from public.storefront_release),
    (select count(*) from public.storefront_bundle_asset),
    (select count(*) from public.storefront_bundle_recipe_asset),
    (select count(*) from public.storefront_bundle_asset where bundle_id <> '22222222-2222-2222-2222-222222222222'),
    (select count(*) from public.storefront_bundle_recipe_asset where bundle_id <> '22222222-2222-2222-2222-222222222222');
")"
test "$state" = "2|0|0|33333333-3333-3333-3333-333333333333|1|1|0|0"

docker exec "$container" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c "
  update public.storefront_release
  set draft_version_id = '22222222-2222-2222-2222-222222222222';
" >/dev/null
audit_call="set role service_role;
select public.install_storefront_custom_redesign(
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  '22222222-2222-2222-2222-222222222222',
  null, 1, 1, 1,
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  '{\"sourceKind\":\"custom\",\"bundle\":{\"source\":{\"kind\":\"custom\"}},\"authoring\":{\"source\":{\"source\":{\"kind\":\"custom\"}}}}',
  '{\"entries\":[{\"key\":\"owned_hero\",\"contentHash\":\"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\",\"mediaType\":\"image/webp\",\"byteSize\":100},{\"key\":\"recipe_hero\",\"contentHash\":\"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\",\"mediaType\":\"image/webp\",\"byteSize\":200}]}',
  '{\"valid\":true}', 'redesign', '{}',
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  repeat('x', 4001), '{}', '{}', '{}', '{}'
);"

set +e
audit_output="$(docker exec "$container" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c "$audit_call" 2>&1)"
audit_status=$?
set -e
test "$audit_status" -ne 0
test "${audit_output#*storefront_bundle_edit_prompt_check}" != "$audit_output"

state="$(docker exec "$container" psql -At -F '|' -U postgres -d postgres -c "
  select
    (select count(*) from public.storefront_bundle_version),
    (select count(*) from public.storefront_bundle_edit),
    (select count(*) from public.storefront_release_history),
    (select draft_version_id from public.storefront_release),
    (select count(*) from public.storefront_bundle_asset),
    (select count(*) from public.storefront_bundle_recipe_asset),
    (select count(*) from public.storefront_bundle_asset where bundle_id <> '22222222-2222-2222-2222-222222222222'),
    (select count(*) from public.storefront_bundle_recipe_asset where bundle_id <> '22222222-2222-2222-2222-222222222222');
")"
test "$state" = "2|0|0|22222222-2222-2222-2222-222222222222|1|1|0|0"

restore_call="set role service_role;
select public.restore_storefront_custom_version(
  '11111111-1111-1111-1111-111111111111',
  '33333333-3333-3333-3333-333333333333',
  '22222222-2222-2222-2222-222222222222',
  '33333333-3333-3333-3333-333333333333',
  null, 1, 1, 1,
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  '{\"bundle\":{\"source\":{\"kind\":\"custom\"},\"schemaVersion\":1,\"runtimeVersion\":1,\"validationProfileVersion\":1,\"assets\":{\"entries\":[{\"key\":\"owned_hero\",\"contentHash\":\"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\",\"mediaType\":\"image/webp\",\"byteSize\":100},{\"key\":\"recipe_hero\",\"contentHash\":\"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\",\"mediaType\":\"image/webp\",\"byteSize\":200}]}}}',
  '{\"entries\":[{\"key\":\"owned_hero\",\"contentHash\":\"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\",\"mediaType\":\"image/webp\",\"byteSize\":100},{\"key\":\"recipe_hero\",\"contentHash\":\"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\",\"mediaType\":\"image/webp\",\"byteSize\":200}]}',
  '{\"valid\":true}',
  '{\"kind\":\"undo\",\"restoredFromVersionId\":\"22222222-2222-2222-2222-222222222222\"}',
  'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
);"

set +e
restore_output="$(docker exec "$container" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c "$restore_call" 2>&1)"
restore_status=$?
set -e
test "$restore_status" -ne 0
test "${restore_output#*storefront_edit_conflict}" != "$restore_output"

state="$(docker exec "$container" psql -At -F '|' -U postgres -d postgres -c "
  select
    (select count(*) from public.storefront_bundle_version),
    (select count(*) from public.storefront_bundle_edit),
    (select count(*) from public.storefront_release_history),
    (select draft_version_id from public.storefront_release),
    (select count(*) from public.storefront_bundle_asset),
    (select count(*) from public.storefront_bundle_recipe_asset),
    (select count(*) from public.storefront_bundle_asset where bundle_id <> '22222222-2222-2222-2222-222222222222'),
    (select count(*) from public.storefront_bundle_recipe_asset where bundle_id <> '22222222-2222-2222-2222-222222222222');
")"
test "$state" = "2|0|0|22222222-2222-2222-2222-222222222222|1|1|0|0"

echo "storefront custom redesign atomic rollback database test passed"
