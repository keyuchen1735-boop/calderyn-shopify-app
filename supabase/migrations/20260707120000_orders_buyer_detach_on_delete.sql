-- Preserve captured-sale history when a buyer self-deletes their account (platform pivot #1b fix).
--
-- Bug: orders.buyer_id was NOT NULL with an `on delete cascade` composite FK to buyer_dim, so a
-- buyer deleting their account CASCADE-DELETED every one of their `orders` rows (and, via the
-- orders->order_line FK, their order lines). The merchant Orders screen, Analytics (Net sales), and
-- live "Sales today" all read the OLTP `orders` table, so a buyer self-delete retroactively dropped
-- the merchant's gross/net/order-count for past windows with no refund event — real captured
-- revenue silently vanished. Only the separate order_fact warehouse (unread by those surfaces)
-- survived, so the "analytics unaffected" guarantee in account.server.ts was false.
--
-- Fix: DETACH instead of delete, exactly like the sibling `cart` table already does
-- (20260629110000_order_spine.sql:45). On a buyer delete, null ONLY buyer_id (column-scoped
-- SET NULL) and keep the orders row + its NOT NULL shop_id, its lines, and its state/totals. The
-- order de-links from the deleted buyer (their PII link is gone) but the sale is preserved on every
-- merchant revenue surface. A bare `on delete set null` would also try to null the NOT NULL
-- shop_id; the column list `(buyer_id)` scopes it. buyer_id must become nullable to hold the null.
--
-- The composite FK is MATCH SIMPLE, so a row with a null buyer_id simply skips FK enforcement.
-- Postgres auto-names the inline order_spine FK `orders_shop_id_buyer_id_fkey`; drop-if-exists then
-- re-add so this is safe whether or not the auto-name matches on a given deployment. Idempotent.

alter table public.orders alter column buyer_id drop not null;

alter table public.orders drop constraint if exists orders_shop_id_buyer_id_fkey;
alter table public.orders add constraint orders_shop_id_buyer_id_fkey
  foreign key (shop_id, buyer_id) references public.buyer_dim (shop_id, id)
  on delete set null (buyer_id);
