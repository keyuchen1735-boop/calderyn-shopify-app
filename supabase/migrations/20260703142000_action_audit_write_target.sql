-- action_audit.write_target (platform-pivot Step 9, extend:write-back): records
-- WHICH system a routed store mutation actually wrote to — Shopify's Admin API
-- (mirror/importing/dual_run authoritative) or Calderyn's owned source-of-truth
-- (live). Nullable: historical rows predate cutover routing, and campaign-side
-- actions (pause/budget/geo/creative) hit Meta/Google — neither of the two store
-- targets — so they leave it null rather than mislabel. Only the store executors
-- (adjust-price, reallocate_inventory, inventory relocate + their undo reversals)
-- stamp it. No backfill — the column is null for every row written before this.
alter table public.action_audit
  add column if not exists write_target text
    check (write_target in ('shopify_admin', 'owned_sot'));
