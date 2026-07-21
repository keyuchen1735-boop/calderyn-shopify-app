alter table public.product_fact
  add column source_provider text,
  add column source_external_id text;

alter table public.shop_integrations
  add column product_facts_sync_attempted_at timestamptz;

create unique index product_fact_source_external_unique
  on public.product_fact(shop_id, source_provider, source_external_id)
  where source_provider is not null and source_external_id is not null;

alter table public.product_fact
  drop constraint product_fact_shop_id_product_id_position_key,
  add constraint product_fact_shop_id_product_id_position_key
    unique (shop_id, product_id, position) deferrable initially deferred;

create or replace function public.replace_product_fact_snapshot(
  p_shop_id uuid,
  p_provider text,
  p_facts jsonb
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  unknown_product text;
  invalid_external_id text;
  inserted_count integer;
begin
  if p_shop_id is null then raise exception 'product fact snapshot requires a shop ID'; end if;
  if p_provider is null or p_provider !~ '^[a-z][a-z0-9_-]{0,31}$' then
    raise exception 'product fact provider is invalid';
  end if;
  if p_facts is null or jsonb_typeof(p_facts) <> 'array' then raise exception 'product fact snapshot must be an array'; end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_shop_id::text || ':' || p_provider, 19790720)
  );

  select coalesce(f.external_id, f.product_external_id) into invalid_external_id
  from jsonb_to_recordset(p_facts) as f(external_id text, product_external_id text)
  where nullif(btrim(f.external_id), '') is null
    or nullif(btrim(f.product_external_id), '') is null
  limit 1;
  if found then raise exception 'product fact snapshot requires stable external IDs'; end if;

  select f.product_external_id into unknown_product
  from jsonb_to_recordset(p_facts) as f(product_external_id text)
  where not exists (
    select 1 from public.product_dim p
    where p.shop_id = p_shop_id and p.external_id = f.product_external_id
  )
  limit 1;
  if unknown_product is not null then
    raise exception 'product fact snapshot references unknown product %', unknown_product;
  end if;

  delete from public.product_fact f
  where f.shop_id = p_shop_id
    and f.source_provider = p_provider
    and not exists (
      select 1 from jsonb_to_recordset(p_facts) as incoming(external_id text)
      where incoming.external_id = f.source_external_id
    );

  insert into public.product_fact (
    shop_id, product_id, kind, text_value, number_value, unit, url_value, position,
    source_provider, source_external_id
  )
  select p_shop_id, p.id, f.kind, f.text_value, f.number_value, f.unit, f.url_value,
    f.position, p_provider, f.external_id
  from jsonb_to_recordset(p_facts) as f(
    product_external_id text, external_id text, kind text, text_value text,
    number_value numeric, unit text, url_value text, position integer
  )
  join public.product_dim p
    on p.shop_id = p_shop_id and p.external_id = f.product_external_id
  on conflict (shop_id, source_provider, source_external_id)
    where source_provider is not null and source_external_id is not null
  do update set
    product_id = excluded.product_id,
    kind = excluded.kind,
    text_value = excluded.text_value,
    number_value = excluded.number_value,
    unit = excluded.unit,
    url_value = excluded.url_value,
    position = excluded.position,
    updated_at = now();
  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

revoke all on function public.replace_product_fact_snapshot(uuid, text, jsonb) from public;
grant execute on function public.replace_product_fact_snapshot(uuid, text, jsonb) to service_role;

create or replace function public.claim_product_fact_syncs(p_limit integer default 5)
returns table(shop_id uuid, shop_domain text)
language sql
security definer
set search_path = ''
as $$
  with candidates as (
    select integrations.shop_id, shops.shop_domain
    from public.shop_integrations integrations
    join public.shops shops on shops.id = integrations.shop_id
    where integrations.kind = 'shopify'
      and integrations.sync_status in ('ready', 'live')
    order by integrations.product_facts_sync_attempted_at asc nulls first,
      integrations.shop_id asc
    for update of integrations skip locked
    limit least(greatest(coalesce(p_limit, 5), 1), 25)
  ), claimed as (
    update public.shop_integrations integrations
    set product_facts_sync_attempted_at = now(), updated_at = now()
    from candidates
    where integrations.shop_id = candidates.shop_id
      and integrations.kind = 'shopify'
    returning integrations.shop_id
  )
  select candidates.shop_id, candidates.shop_domain
  from candidates
  join claimed using (shop_id)
  order by candidates.shop_id;
$$;

revoke all on function public.claim_product_fact_syncs(integer) from public;
grant execute on function public.claim_product_fact_syncs(integer) to service_role;
