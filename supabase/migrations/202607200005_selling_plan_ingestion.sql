alter table public.selling_plan_group
  add column provider text not null default 'native',
  add column external_id text;
alter table public.selling_plan
  add column provider text not null default 'native',
  add column external_id text;

create unique index selling_plan_group_provider_external_key
  on public.selling_plan_group(shop_id, provider, external_id) where external_id is not null;
create unique index selling_plan_provider_external_key
  on public.selling_plan(shop_id, provider, external_id) where external_id is not null;

create or replace function public.replace_selling_plan_snapshot(
  p_shop_id uuid, p_provider text, p_groups jsonb, p_plans jsonb, p_eligibility jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare
  c_groups integer;
  c_plans integer;
  c_eligibility integer;
begin
  if p_provider is null or btrim(p_provider) = '' or char_length(p_provider) > 255
     or jsonb_typeof(p_groups) <> 'array' or jsonb_typeof(p_plans) <> 'array'
     or jsonb_typeof(p_eligibility) <> 'array' then
    raise exception 'invalid selling-plan snapshot envelope';
  end if;
  perform 1 from public.shops where id = p_shop_id for update;
  if not found then raise exception 'selling-plan snapshot shop not found'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_shop_id::text || ':' || p_provider, 0));

  if exists (select 1 from jsonb_to_recordset(p_groups) as g(external_id text, name text)
      where coalesce(btrim(g.external_id), '') = '' or coalesce(btrim(g.name), '') = '')
     or exists (select 1 from jsonb_to_recordset(p_plans) as p(external_id text, group_external_id text, name text, cadence text)
      where coalesce(btrim(p.external_id), '') = '' or coalesce(btrim(p.group_external_id), '') = ''
        or coalesce(btrim(p.name), '') = '' or coalesce(btrim(p.cadence), '') = '')
     or exists (select 1 from jsonb_to_recordset(p_eligibility) as e(variant_external_id text, plan_external_id text, price_cents integer, currency text)
      where coalesce(btrim(e.variant_external_id), '') = '' or coalesce(btrim(e.plan_external_id), '') = ''
        or e.price_cents < 0 or (e.price_cents is not null and coalesce(btrim(e.currency), '') = '')) then
    raise exception 'invalid selling-plan snapshot row';
  end if;
  if (select count(*) from jsonb_to_recordset(p_groups) as g(external_id text))
       <> (select count(distinct external_id) from jsonb_to_recordset(p_groups) as g(external_id text))
     or (select count(*) from jsonb_to_recordset(p_plans) as p(external_id text))
       <> (select count(distinct external_id) from jsonb_to_recordset(p_plans) as p(external_id text))
     or (select count(*) from jsonb_to_recordset(p_eligibility) as e(variant_external_id text, plan_external_id text))
       <> (select count(distinct (variant_external_id, plan_external_id)) from jsonb_to_recordset(p_eligibility) as e(variant_external_id text, plan_external_id text)) then
    raise exception 'duplicate selling-plan snapshot identity';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_plans) as p(group_external_id text)
    where not exists (select 1 from jsonb_to_recordset(p_groups) as g(external_id text) where g.external_id = p.group_external_id)
  ) or exists (
    select 1 from jsonb_to_recordset(p_eligibility) as e(plan_external_id text)
    where not exists (select 1 from jsonb_to_recordset(p_plans) as p(external_id text) where p.external_id = e.plan_external_id)
  ) then raise exception 'selling-plan snapshot reference is unresolved'; end if;
  if exists (
    select 1 from jsonb_to_recordset(p_eligibility) as e(variant_external_id text)
    where not exists (select 1 from public.variant_dim v where v.shop_id = p_shop_id and v.external_id = e.variant_external_id)
  ) then raise exception 'selling-plan variant mapping failed'; end if;

  insert into public.selling_plan_group (shop_id, provider, external_id, name)
  select p_shop_id, p_provider, g.external_id, g.name
  from jsonb_to_recordset(p_groups) as g(external_id text, name text)
  on conflict (shop_id, provider, external_id) where external_id is not null
  do update set name = excluded.name;

  insert into public.selling_plan (shop_id, provider, external_id, group_id, name, cadence)
  select p_shop_id, p_provider, p.external_id, g.id, p.name, p.cadence
  from jsonb_to_recordset(p_plans) as p(external_id text, group_external_id text, name text, cadence text)
  join public.selling_plan_group g on g.shop_id = p_shop_id and g.provider = p_provider
    and g.external_id = p.group_external_id
  on conflict (shop_id, provider, external_id) where external_id is not null
  do update set group_id = excluded.group_id, name = excluded.name, cadence = excluded.cadence;

  insert into public.variant_selling_plan (shop_id, variant_id, selling_plan_id, price_cents, currency)
  select p_shop_id, v.id, sp.id, e.price_cents, upper(e.currency)
  from jsonb_to_recordset(p_eligibility) as e(variant_external_id text, plan_external_id text, price_cents integer, currency text)
  join public.variant_dim v on v.shop_id = p_shop_id and v.external_id = e.variant_external_id
  join public.selling_plan sp on sp.shop_id = p_shop_id and sp.provider = p_provider
    and sp.external_id = e.plan_external_id
  on conflict (shop_id, variant_id, selling_plan_id)
  do update set price_cents = excluded.price_cents, currency = excluded.currency;

  delete from public.variant_selling_plan vsp
  using public.selling_plan sp, public.variant_dim v
  where vsp.shop_id = p_shop_id and sp.shop_id = p_shop_id and sp.provider = p_provider
    and sp.id = vsp.selling_plan_id and v.id = vsp.variant_id and v.shop_id = p_shop_id
    and not exists (
      select 1 from jsonb_to_recordset(p_eligibility) as e(variant_external_id text, plan_external_id text)
      where e.variant_external_id = v.external_id and e.plan_external_id = sp.external_id
    );
  delete from public.selling_plan sp
  where sp.shop_id = p_shop_id and sp.provider = p_provider
    and not exists (select 1 from jsonb_to_recordset(p_plans) as p(external_id text) where p.external_id = sp.external_id);
  delete from public.selling_plan_group sg
  where sg.shop_id = p_shop_id and sg.provider = p_provider
    and not exists (select 1 from jsonb_to_recordset(p_groups) as g(external_id text) where g.external_id = sg.external_id);

  select count(*) into c_groups from public.selling_plan_group where shop_id = p_shop_id and provider = p_provider;
  select count(*) into c_plans from public.selling_plan where shop_id = p_shop_id and provider = p_provider;
  select count(*) into c_eligibility from public.variant_selling_plan vsp
    join public.selling_plan sp on sp.id = vsp.selling_plan_id and sp.shop_id = vsp.shop_id
    where vsp.shop_id = p_shop_id and sp.provider = p_provider;
  return jsonb_build_object('groups', c_groups, 'plans', c_plans, 'eligibility', c_eligibility);
end;
$function$;

revoke all on function public.replace_selling_plan_snapshot(uuid,text,jsonb,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.replace_selling_plan_snapshot(uuid,text,jsonb,jsonb,jsonb) to service_role;
