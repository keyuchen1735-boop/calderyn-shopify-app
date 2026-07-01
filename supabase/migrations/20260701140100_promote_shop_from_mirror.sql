-- Import-from-Shopify (#13.promote): per-shop, idempotent promote of mirrored
-- Shopify data into the owned tables. Catalog + collections are delegated to the
-- shared promote_shop_catalog() (defined in Slice 1) so the logic never drifts;
-- this function adds only the inventory_balance seed. Re-runnable: every insert
-- is on-conflict-do-nothing.
create or replace function public.promote_shop_from_mirror(p_shop_id uuid) returns jsonb
  language plpgsql
  set search_path to ''
as $function$
declare
  c_products int;
  c_variants int;
  c_collections int;
  c_balances int;
begin
  -- Catalog + collections (shared, idempotent). Runs before inventory so order
  -- lines resolve and variant_dim exists for the balance FK.
  perform public.promote_shop_catalog(p_shop_id);

  -- Inventory: seed inventory_balance.on_hand from the LATEST observation per
  -- (variant, location). Guarded so an orphan fact (variant/location not present
  -- in the owned tables) is skipped rather than failing the whole import.
  -- greatest(...,0): a negative observation (oversold mirror row) must not seed
  -- negative physical stock (matches the canonical inventory_seed clamp).
  insert into public.inventory_balance (shop_id, variant_id, location_id, on_hand)
  select distinct on (f.sku_id, f.location_id)
    f.shop_id, f.sku_id, f.location_id, greatest(f.available, 0)
  from public.inventory_level_fact f
  where f.shop_id = p_shop_id
    and exists (select 1 from public.variant_dim v where v.id = f.sku_id)
    and exists (select 1 from public.location_dim l where l.id = f.location_id)
  order by f.sku_id, f.location_id, f.observed_at desc
  on conflict (variant_id, location_id) do nothing;

  select count(*) into c_products from public.product_dim where shop_id = p_shop_id;
  select count(*) into c_variants from public.variant_dim where shop_id = p_shop_id;
  select count(*) into c_collections from public.collection_dim where shop_id = p_shop_id;
  select count(*) into c_balances from public.inventory_balance where shop_id = p_shop_id;

  return jsonb_build_object(
    'products', c_products,
    'variants', c_variants,
    'collections', c_collections,
    'balances', c_balances
  );
end $function$;
