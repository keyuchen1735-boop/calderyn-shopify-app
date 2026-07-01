-- Ensure every shop has at least one location (owned stores have none yet).
insert into public.location_dim (shop_id, name, active, priority)
select s.id, 'Primary', true, 0
from public.shops s
where not exists (select 1 from public.location_dim l where l.shop_id = s.id);

-- Seed inventory_balance from the AUTHORITATIVE per-location stock -- the latest
-- inventory_level_fact observation per (variant, location). This is the real
-- mirrored/backfilled stock; variant_dim.inventory_on_hand is 0 for promoted
-- rows, so seeding from it would zero every imported store. Idempotent.
-- on_hand is physical units, so clamp the (Shopify-derived) available at 0 -- a
-- negative observation (oversold mirror row) must not seed negative physical stock.
-- Tie-break by source_version desc to match the canonical latest-observation
-- ordering used by v_sku_inventory_history / v_sku_regional_demand.
insert into public.inventory_balance (shop_id, variant_id, location_id, on_hand)
select distinct on (f.sku_id, f.location_id) f.shop_id, f.sku_id, f.location_id, greatest(f.available, 0)
from public.inventory_level_fact f
order by f.sku_id, f.location_id, f.observed_at desc, f.source_version desc
on conflict (variant_id, location_id) do nothing;

-- Fresh products typed in the Slice 1 editor have a non-zero inventory_on_hand
-- but no observation yet; seed that count at the shop's primary (lowest-priority)
-- location so a brand-new owned product still has stock.
insert into public.inventory_balance (shop_id, variant_id, location_id, on_hand)
select v.shop_id, v.id,
  (select l.id from public.location_dim l where l.shop_id = v.shop_id order by l.priority, l.created_at limit 1),
  v.inventory_on_hand
from public.variant_dim v
where coalesce(v.inventory_on_hand, 0) > 0
  and not exists (select 1 from public.inventory_level_fact f where f.sku_id = v.id)
  and exists (select 1 from public.location_dim l where l.shop_id = v.shop_id)
on conflict (variant_id, location_id) do nothing;
