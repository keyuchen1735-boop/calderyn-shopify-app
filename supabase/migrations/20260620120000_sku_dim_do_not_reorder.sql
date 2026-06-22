-- app/discontinue_sku (Phase 2): an internal "do not reorder" flag on the SKU's
-- product. Set when a merchant (or, later, autopilot) discontinues a SKU; it
-- surfaces on the Inventory surface and BLOCKS create_po_draft so a discontinued
-- product can never be re-ordered. Cleared by the discontinue_sku undo. Idempotent
-- (if not exists) so it composes with the test-schema mirror. RLS unchanged — the
-- added column inherits sku_dim's existing read/write policy.
alter table public.sku_dim
  add column if not exists do_not_reorder boolean not null default false;

create index if not exists sku_dim_do_not_reorder_idx
  on public.sku_dim (shop_id) where do_not_reorder = true;
