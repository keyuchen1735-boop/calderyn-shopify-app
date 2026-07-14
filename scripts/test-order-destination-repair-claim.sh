#!/usr/bin/env bash

set -euo pipefail

container="calderyn-destination-claim-test-$$"
first_output="$(mktemp)"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -f "$first_output"
}
trap cleanup EXIT

docker run --rm -d \
  --name "$container" \
  -e POSTGRES_PASSWORD=postgres \
  postgres:16-alpine >/dev/null

for _ in {1..30}; do
  if docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$container" pg_isready -U postgres >/dev/null

docker exec "$container" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c "
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;
  create table public.shops (
    id uuid primary key,
    shop_domain text not null
  );
  create table public.shop_integrations (
    shop_id uuid not null references public.shops(id),
    kind text not null,
    sync_status text not null
  );
  create table public.order_fact (
    shop_id uuid not null references public.shops(id),
    created_at_source timestamptz not null,
    external_id text not null
  );
" >/dev/null

docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  < supabase/migrations/20260713160000_order_destination_repair.sql >/dev/null

docker exec "$container" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c "
  insert into public.shops(id, shop_domain)
  select
    ('00000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
    'shop-' || i || '.myshopify.com'
  from generate_series(1, 10) i;

  insert into public.shop_integrations(shop_id, kind, sync_status)
  select id, 'shopify', 'ready' from public.shops;
" >/dev/null

# Keep the first transaction open after its claim so the second caller must use
# SKIP LOCKED and select a disjoint batch.
docker exec "$container" psql -v ON_ERROR_STOP=1 -At -U postgres -d postgres -c "
  begin;
  select shop_id from public.claim_order_destination_repairs(5) order by shop_id;
  select pg_sleep(5);
  commit;
" >"$first_output" &
first_pid=$!
sleep 1

second_claim="$(docker exec "$container" psql -v ON_ERROR_STOP=1 -At -U postgres -d postgres -c \
  "select shop_id from public.claim_order_destination_repairs(5) order by shop_id;")"
wait "$first_pid"

first_claim="$(rg '^00000000-' "$first_output")"
expected_first=$'00000000-0000-0000-0000-000000000001\n00000000-0000-0000-0000-000000000002\n00000000-0000-0000-0000-000000000003\n00000000-0000-0000-0000-000000000004\n00000000-0000-0000-0000-000000000005'
expected_second=$'00000000-0000-0000-0000-000000000006\n00000000-0000-0000-0000-000000000007\n00000000-0000-0000-0000-000000000008\n00000000-0000-0000-0000-000000000009\n00000000-0000-0000-0000-000000000010'

test "$first_claim" = "$expected_first"
test "$second_claim" = "$expected_second"

fresh_claims="$(docker exec "$container" psql -v ON_ERROR_STOP=1 -At -U postgres -d postgres -c \
  "select count(*) from public.claim_order_destination_repairs(5);")"
test "$fresh_claims" = "0"

expired_claim="$(docker exec "$container" psql -v ON_ERROR_STOP=1 -At -U postgres -d postgres -c "
  update public.shop_integrations
     set destination_repair_attempted_at = now() - interval '31 minutes'
   where shop_id = '00000000-0000-0000-0000-000000000001';
  select shop_id from public.claim_order_destination_repairs(5);
" | tail -1)"
test "$expired_claim" = "00000000-0000-0000-0000-000000000001"

if docker exec "$container" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c "
  set role authenticated;
  select * from public.claim_order_destination_repairs(1);
" >/dev/null 2>&1; then
  echo "authenticated role unexpectedly executed claim RPC" >&2
  exit 1
fi

echo "destination repair claim database test passed"
