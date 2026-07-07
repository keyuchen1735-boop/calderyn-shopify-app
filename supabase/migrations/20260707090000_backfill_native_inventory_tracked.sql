-- Backfill inventory_tracked for native (non-imported) product variants.
--
-- Native products created through the dashboard were written with
-- inventory_tracked = NULL, which the storefront availability layer
-- (catalog.owned.server.ts toVariant) coerces to "untracked = always
-- available" — so entered stock never gated availability and the product
-- could never show sold out. The write path now sets the flag correctly for
-- new variants; this backfills the existing ones.
--
-- CONSERVATIVE by design: only variants that currently have on_hand > 0. Those
-- stay available right now (no visible change today), but once their stock
-- reaches 0 they will correctly show sold out. Variants sitting at on_hand = 0
-- are left untracked so a make-to-order product that was never stocked is not
-- silently flipped to "sold out". Imported variants (external_id present) keep
-- the tracked flag Shopify supplied.
update variant_dim
set inventory_tracked = true
where inventory_tracked is null
  and external_id is null
  and coalesce(inventory_on_hand, 0) > 0;
