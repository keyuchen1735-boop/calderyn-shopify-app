create extension if not exists pgcrypto with schema extensions;

alter table public.cart_line
  add column personalization jsonb not null default '{}'::jsonb,
  add column personalization_hash text;

update public.cart_line
set personalization_hash = encode(
  extensions.digest(convert_to(personalization::text, 'UTF8'), 'sha256'),
  'hex'
);

alter table public.cart_line
  alter column personalization_hash set default encode(
    extensions.digest(convert_to('{}', 'UTF8'), 'sha256'),
    'hex'
  ),
  alter column personalization_hash set not null,
  drop constraint if exists cart_line_shop_id_cart_id_variant_id_key,
  add constraint cart_line_shop_cart_variant_personalization_key
    unique (shop_id, cart_id, variant_id, personalization_hash);

alter table public.order_line
  add column personalization jsonb not null default '{}'::jsonb;

create or replace function public.cart_add_line_atomic(
  p_shop_id uuid,
  p_cart_id uuid,
  p_variant_id text,
  p_quantity integer,
  p_unit_price_cents integer,
  p_currency text,
  p_title_snapshot text,
  p_personalization jsonb
) returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_personalization jsonb := coalesce(p_personalization, '{}'::jsonb);
  v_personalization_hash text;
  v_result jsonb;
begin
  if p_quantity is null or p_quantity < 1 or p_quantity > 999 then
    raise exception 'cart line quantity must be between 1 and 999';
  end if;
  if p_variant_id is null or btrim(p_variant_id) = ''
     or p_unit_price_cents is null or p_unit_price_cents < 0
     or p_currency is null or btrim(p_currency) = ''
     or p_title_snapshot is null or btrim(p_title_snapshot) = '' then
    raise exception 'invalid cart line snapshot';
  end if;
  if jsonb_typeof(v_personalization) <> 'object' then
    raise exception 'invalid cart line personalization';
  end if;
  if (select count(*) from jsonb_object_keys(v_personalization)) > 4
     or exists (
       select 1
       from jsonb_each(v_personalization) as entry(key, value)
       where char_length(entry.key) > 40
          or entry.key not in ('engraving', 'giftNote', 'giftWrap', 'recipient')
          or jsonb_typeof(entry.value) <> 'string'
          or char_length(entry.value #>> '{}') > 240
  ) then
    raise exception 'invalid cart line personalization';
  end if;

  v_personalization_hash := encode(
    extensions.digest(convert_to(v_personalization::text, 'UTF8'), 'sha256'),
    'hex'
  );

  perform 1
  from public.cart
  where shop_id = p_shop_id
    and id = p_cart_id
    and state = 'cart'
  for update;
  if not found then
    raise exception 'active cart not found for shop';
  end if;

  insert into public.cart_line (
    shop_id,
    cart_id,
    variant_id,
    quantity,
    unit_price_cents,
    currency,
    title_snapshot,
    personalization,
    personalization_hash
  ) values (
    p_shop_id,
    p_cart_id,
    p_variant_id,
    p_quantity,
    p_unit_price_cents,
    lower(p_currency),
    p_title_snapshot,
    v_personalization,
    v_personalization_hash
  )
  on conflict (shop_id, cart_id, variant_id, personalization_hash)
  do update set
    quantity = least(999, public.cart_line.quantity + excluded.quantity)
  returning jsonb_build_object(
    'id', id,
    'cart_id', cart_id,
    'variant_id', variant_id,
    'quantity', quantity,
    'unit_price_cents', unit_price_cents,
    'currency', currency,
    'title_snapshot', title_snapshot,
    'personalization', personalization
  ) into v_result;

  return v_result;
end;
$$;

create or replace function public.cart_add_line_atomic(
  p_shop_id uuid,
  p_cart_id uuid,
  p_variant_id text,
  p_quantity integer,
  p_unit_price_cents integer,
  p_currency text,
  p_title_snapshot text
) returns jsonb
language sql
security definer set search_path = ''
as $$
  select public.cart_add_line_atomic(
    p_shop_id => p_shop_id,
    p_cart_id => p_cart_id,
    p_variant_id => p_variant_id,
    p_quantity => p_quantity,
    p_unit_price_cents => p_unit_price_cents,
    p_currency => p_currency,
    p_title_snapshot => p_title_snapshot,
    p_personalization => '{}'::jsonb
  );
$$;

revoke all on function public.cart_add_line_atomic(uuid, uuid, text, integer, integer, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.cart_add_line_atomic(uuid, uuid, text, integer, integer, text, text, jsonb)
  to service_role;
revoke all on function public.cart_add_line_atomic(uuid, uuid, text, integer, integer, text, text)
  from public, anon, authenticated;
grant execute on function public.cart_add_line_atomic(uuid, uuid, text, integer, integer, text, text)
  to service_role;
