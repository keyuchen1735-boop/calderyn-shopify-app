create or replace function public.cart_add_lines_atomic(
  p_shop_id uuid, p_cart_id uuid, p_lines jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare
  v_line jsonb;
  v_result jsonb := '[]'::jsonb;
  v_added jsonb;
  v_currency_count integer;
begin
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 1 or jsonb_array_length(p_lines) > 12
     or (select sum((value->>'quantity')::integer) from jsonb_array_elements(p_lines)) < 2
     or (select sum((value->>'quantity')::integer) from jsonb_array_elements(p_lines)) > 12 then
    raise exception 'bundle must contain 2 to 12 selected slots';
  end if;
  perform 1 from public.cart where shop_id = p_shop_id and id = p_cart_id and state = 'cart' for update;
  if not found then raise exception 'active cart not found for shop'; end if;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    if (select count(*) from jsonb_object_keys(v_line)) <> 7
       or (v_line->>'quantity')::integer < 1 or (v_line->>'quantity')::integer > 12
       or coalesce(v_line->>'variant_id', '') = ''
       or (v_line->>'unit_price_cents')::integer < 0
       or coalesce(v_line->>'currency', '') = ''
       or coalesce(v_line->>'title_snapshot', '') = ''
       or v_line->'personalization' <> '{}'::jsonb
       or v_line->'selling_plan_id' <> 'null'::jsonb then
      raise exception 'invalid trusted bundle line snapshot';
    end if;
  end loop;
  select count(distinct lower(currency)) into v_currency_count
  from (
    select cl.currency
    from public.cart_line cl
    where cl.shop_id = p_shop_id and cl.cart_id = p_cart_id
    union all
    select value->>'currency' as currency from jsonb_array_elements(p_lines)
  ) currencies;
  if v_currency_count > 1 then raise exception 'bundle currency conflicts with cart currency'; end if;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    if exists (
      select 1 from public.cart_line cl
      where cl.shop_id = p_shop_id and cl.cart_id = p_cart_id
        and cl.variant_id = v_line->>'variant_id'
        and cl.personalization = '{}'::jsonb and cl.selling_plan_id = ''
        and cl.quantity + (v_line->>'quantity')::integer > 999
    ) then
      raise exception 'resulting cart line quantity exceeds 999';
    end if;
  end loop;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_added := public.cart_add_line_atomic(p_shop_id, p_cart_id, v_line->>'variant_id', (v_line->>'quantity')::integer,
      (v_line->>'unit_price_cents')::integer, v_line->>'currency', v_line->>'title_snapshot', '{}'::jsonb, null);
    v_result := v_result || jsonb_build_array(v_added);
  end loop;
  return v_result;
end;
$function$;

revoke all on function public.cart_add_lines_atomic(uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.cart_add_lines_atomic(uuid,uuid,jsonb) to service_role;
