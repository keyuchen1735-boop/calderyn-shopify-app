-- Atomic buyer-cart add. The service resolves the live shop-scoped variant and
-- supplies its trusted snapshot; this function owns the concurrent cart mutation.
create or replace function public.cart_add_line_atomic(
  p_shop_id uuid,
  p_cart_id uuid,
  p_variant_id text,
  p_quantity integer,
  p_unit_price_cents integer,
  p_currency text,
  p_title_snapshot text
) returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
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
    title_snapshot
  ) values (
    p_shop_id,
    p_cart_id,
    p_variant_id,
    p_quantity,
    p_unit_price_cents,
    lower(p_currency),
    p_title_snapshot
  )
  on conflict (shop_id, cart_id, variant_id)
  do update set
    quantity = least(999, public.cart_line.quantity + excluded.quantity)
  returning jsonb_build_object(
    'id', id,
    'cart_id', cart_id,
    'variant_id', variant_id,
    'quantity', quantity,
    'unit_price_cents', unit_price_cents,
    'currency', currency,
    'title_snapshot', title_snapshot
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.cart_add_line_atomic(uuid, uuid, text, integer, integer, text, text)
  from public, anon, authenticated;
grant execute on function public.cart_add_line_atomic(uuid, uuid, text, integer, integer, text, text)
  to service_role;
