-- Compare-at (was) price per variant, in cents. Nullable: most variants have no
-- struck-through original price. The storefront renders it only when it is
-- strictly greater than retail_price_cents; the check below just keeps the
-- column non-negative. Re-runnable: add-if-absent + drop/re-add the constraint.
alter table public.variant_dim add column if not exists compare_at_price_cents integer;
alter table public.variant_dim drop constraint if exists variant_compare_at_nonneg;
alter table public.variant_dim add constraint variant_compare_at_nonneg
  check (compare_at_price_cents is null or compare_at_price_cents >= 0);
