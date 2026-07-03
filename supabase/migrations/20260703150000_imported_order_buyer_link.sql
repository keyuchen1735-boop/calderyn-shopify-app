-- Order<->customer relink (platform-pivot Step 10, #13.customers). The order-history promote
-- (20260703140000) materialized imported_order with NO customer linkage by construction — the
-- warehouse order_fact strips all buyer PII, so the promoted headers had no one to attribute to.
-- Once the customer stage re-pulls the buyers into buyer_dim (the PII store), the relink pass
-- (app/lib/import/relink.server.ts) matches each imported order's Shopify customer email to
-- buyer_dim.email_normalized and records the result here.
--
-- WHAT LANDS HERE — AND WHY IT IS NOT PII: buyer_id is a UUID REFERENCE to buyer_dim, not buyer
-- PII. No email / name / phone / address is stored on imported_order; the customer email is
-- resolved in memory during the relink and never persisted outside the buyer_* store. This keeps
-- the hard invariant intact — buyer PII lives ONLY in buyer_dim / buyer_address / buyer_consent.
-- (This is imported_order, the OWNED import artifact — NOT the warehouse mirror order_fact, which
-- gains no buyer column: the mirror stays PII-free, exactly as #13.customers requires.)
--
-- COMPOSITE FK cross-tenant guard (matches order_spine cart/orders, 20260629110000): the app writes
-- via the BYPASSRLS service-role key, so the (shop_id, buyer_id) composite FK to buyer_dim
-- (shop_id, id) is the only thing that rejects a buyer_id from a different tenant. buyer_id is
-- nullable — a guest-checkout order (or one whose customer was not re-pulled) simply stays NULL,
-- and MATCH SIMPLE skips the FK for a NULL, so those orders are valid and unlinked.
--
-- ON DELETE SET NULL (buyer_id): a GDPR buyer deletion must UNLINK order history, never delete it.
-- The column-scoped SET NULL nulls ONLY buyer_id (keeping the row + its NOT NULL shop_id); a bare
-- SET NULL would try to null shop_id too and raise a not-null violation. (PG15+/Supabase.)

alter table public.imported_order
  add column if not exists buyer_id uuid;

alter table public.imported_order
  drop constraint if exists imported_order_buyer_fk;
alter table public.imported_order
  add constraint imported_order_buyer_fk
  foreign key (shop_id, buyer_id) references public.buyer_dim (shop_id, id) on delete set null (buyer_id);

create index if not exists imported_order_buyer_idx on public.imported_order (shop_id, buyer_id);
