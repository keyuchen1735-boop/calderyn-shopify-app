create table public.selling_plan_group (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  name text not null check (btrim(name) <> ''),
  created_at timestamptz not null default now()
);

create table public.selling_plan (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  group_id uuid not null references public.selling_plan_group(id) on delete cascade,
  name text not null check (btrim(name) <> ''),
  cadence text not null check (btrim(cadence) <> ''),
  created_at timestamptz not null default now()
);

create table public.variant_selling_plan (
  shop_id uuid not null references public.shops(id) on delete cascade,
  variant_id uuid not null references public.variant_dim(id) on delete cascade,
  selling_plan_id uuid not null references public.selling_plan(id) on delete cascade,
  price_cents integer check (price_cents is null or price_cents >= 0),
  currency text check (price_cents is null or (currency is not null and btrim(currency) <> '')),
  primary key (shop_id, variant_id, selling_plan_id)
);

alter table public.variant_dim
  add constraint variant_dim_shop_id_id_key unique (shop_id, id);
alter table public.selling_plan_group
  add constraint selling_plan_group_shop_id_id_key unique (shop_id, id);
alter table public.selling_plan
  add constraint selling_plan_shop_id_id_key unique (shop_id, id),
  add constraint selling_plan_shop_group_fkey foreign key (shop_id, group_id)
    references public.selling_plan_group(shop_id, id) on delete cascade;
alter table public.variant_selling_plan
  add constraint variant_selling_plan_shop_variant_fkey foreign key (shop_id, variant_id)
    references public.variant_dim(shop_id, id) on delete cascade,
  add constraint variant_selling_plan_shop_plan_fkey foreign key (shop_id, selling_plan_id)
    references public.selling_plan(shop_id, id) on delete cascade;

alter table public.selling_plan_group enable row level security;
alter table public.selling_plan enable row level security;
alter table public.variant_selling_plan enable row level security;
revoke all on public.selling_plan_group, public.selling_plan, public.variant_selling_plan from anon, authenticated;

alter table public.cart_line
  add column selling_plan_id text not null default '',
  add column selling_plan_name text,
  add column selling_plan_cadence text,
  drop constraint if exists cart_line_shop_cart_variant_personalization_key,
  add constraint cart_line_shop_cart_variant_personalization_plan_key
    unique (shop_id, cart_id, variant_id, personalization_hash, selling_plan_id);

alter table public.order_line
  add column selling_plan_id text,
  add column selling_plan_name text,
  add column selling_plan_cadence text;

create or replace function public.cart_add_line_atomic(
  p_shop_id uuid, p_cart_id uuid, p_variant_id text, p_quantity integer,
  p_unit_price_cents integer, p_currency text, p_title_snapshot text,
  p_personalization jsonb, p_selling_plan_id text
) returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare
  v_personalization jsonb := coalesce(p_personalization, '{}'::jsonb);
  v_hash text;
  v_plan_id text := coalesce(p_selling_plan_id, '');
  v_plan_name text;
  v_plan_cadence text;
  v_plan_price integer;
  v_plan_currency text;
  v_result jsonb;
begin
  if p_quantity is null or p_quantity < 1 or p_quantity > 999 then raise exception 'cart line quantity must be between 1 and 999'; end if;
  if p_variant_id is null or btrim(p_variant_id) = '' or p_unit_price_cents is null or p_unit_price_cents < 0
     or p_currency is null or btrim(p_currency) = '' or p_title_snapshot is null or btrim(p_title_snapshot) = '' then
    raise exception 'invalid cart line snapshot';
  end if;
  if jsonb_typeof(v_personalization) <> 'object' or (select count(*) from jsonb_object_keys(v_personalization)) > 4
     or exists (select 1 from jsonb_each(v_personalization) entry
       where char_length(entry.key) > 40 or entry.key not in ('engraving','giftNote','giftWrap','recipient')
       or jsonb_typeof(entry.value) <> 'string' or char_length(entry.value #>> '{}') > 240) then
    raise exception 'invalid cart line personalization';
  end if;
  if v_plan_id <> '' then
    select sp.name, sp.cadence, vsp.price_cents, vsp.currency
      into v_plan_name, v_plan_cadence, v_plan_price, v_plan_currency
    from public.variant_selling_plan vsp
    join public.selling_plan sp on sp.id = vsp.selling_plan_id and sp.shop_id = vsp.shop_id
    where vsp.shop_id = p_shop_id and vsp.variant_id::text = p_variant_id
      and vsp.selling_plan_id::text = v_plan_id;
    if not found then raise exception 'selling plan is not eligible for variant'; end if;
  end if;
  v_hash := encode(extensions.digest(convert_to(v_personalization::text, 'UTF8'), 'sha256'), 'hex');
  perform 1 from public.cart where shop_id = p_shop_id and id = p_cart_id and state = 'cart' for update;
  if not found then raise exception 'active cart not found for shop'; end if;

  insert into public.cart_line (shop_id, cart_id, variant_id, quantity, unit_price_cents, currency,
    title_snapshot, personalization, personalization_hash, selling_plan_id, selling_plan_name, selling_plan_cadence)
  values (p_shop_id, p_cart_id, p_variant_id, p_quantity, coalesce(v_plan_price, p_unit_price_cents),
    lower(coalesce(v_plan_currency, p_currency)), p_title_snapshot, v_personalization, v_hash,
    v_plan_id, v_plan_name, v_plan_cadence)
  on conflict (shop_id, cart_id, variant_id, personalization_hash, selling_plan_id)
  do update set quantity = least(999, public.cart_line.quantity + excluded.quantity)
  returning jsonb_build_object('id', id, 'cart_id', cart_id, 'variant_id', variant_id, 'quantity', quantity,
    'unit_price_cents', unit_price_cents, 'currency', currency, 'title_snapshot', title_snapshot,
    'personalization', personalization, 'selling_plan_id', nullif(selling_plan_id, ''),
    'selling_plan_name', selling_plan_name, 'selling_plan_cadence', selling_plan_cadence) into v_result;
  return v_result;
end;
$function$;

create or replace function public.cart_add_line_atomic(
  p_shop_id uuid, p_cart_id uuid, p_variant_id text, p_quantity integer,
  p_unit_price_cents integer, p_currency text, p_title_snapshot text, p_personalization jsonb
) returns jsonb language sql security definer set search_path = '' as $function$
  select public.cart_add_line_atomic(p_shop_id, p_cart_id, p_variant_id, p_quantity,
    p_unit_price_cents, p_currency, p_title_snapshot, p_personalization, null);
$function$;

revoke all on function public.cart_add_line_atomic(uuid,uuid,text,integer,integer,text,text,jsonb,text) from public, anon, authenticated;
grant execute on function public.cart_add_line_atomic(uuid,uuid,text,integer,integer,text,text,jsonb,text) to service_role;
