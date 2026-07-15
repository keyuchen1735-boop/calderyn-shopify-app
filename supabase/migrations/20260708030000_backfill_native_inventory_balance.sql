-- Companion to 20260707090000_backfill_native_inventory_tracked.sql.
--
-- Bug: that backfill flipped inventory_tracked = true for every native variant with
-- inventory_on_hand > 0, and checkout now HARD-GATES tracked lines on the inventory ledger
-- (order/checkout.server.ts reserveStock -> OutOfStockError -> HTTP 409). But native products
-- created through the dashboard editor BEFORE this diff's write-path fix never wrote an
-- inventory_balance row (createProduct/updateProduct only started seeding the ledger in this
-- same batch). The one-time seed (20260629160200_inventory_seed.sql) only covered variants that
-- existed on 2026-06-29.
--
-- Result for the in-between cohort (native variant created/restocked via the editor after the
-- seed, on_hand > 0, no balance row): the storefront still shows it available (availability falls
-- back to the flat inventory_on_hand column when no balance row exists), but checkout reserves
-- against a non-existent ledger balance and 409s forever — an advertised product that can never
-- be bought. New products created from here on are fine (the write path seeds the ledger); only
-- this historical cohort is stranded.
--
-- Fix: seed a balance row from the flat inventory_on_hand for any variant that has stock but no
-- inventory_balance row, at the shop's primary (lowest-priority) location — mirroring the third
-- INSERT of the original seed. Idempotent (on conflict do nothing); only touches variants that
-- have NO balance row today, so it never overwrites a live ledger balance.
insert into public.inventory_balance (shop_id, variant_id, location_id, on_hand)
select v.shop_id, v.id,
  (select l.id from public.location_dim l where l.shop_id = v.shop_id order by l.priority, l.created_at limit 1),
  v.inventory_on_hand
from public.variant_dim v
where coalesce(v.inventory_on_hand, 0) > 0
  and not exists (select 1 from public.inventory_balance b where b.variant_id = v.id)
  and exists (select 1 from public.location_dim l where l.shop_id = v.shop_id)
on conflict (variant_id, location_id) do nothing;
