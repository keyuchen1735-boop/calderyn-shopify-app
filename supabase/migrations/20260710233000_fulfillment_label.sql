-- Shipping deferred D2 (2026-07-10 design): EasyPost label purchase.
-- Label fields on the fulfillment spine. easypost_shipment_id is the idempotency key:
-- one EasyPost shipment can be bought exactly once, and the partial unique index makes
-- sure no two fulfillments in a shop ever claim the same purchased shipment.
alter table public.fulfillment add column if not exists label_url text;
alter table public.fulfillment add column if not exists label_cost_cents int
  check (label_cost_cents is null or label_cost_cents >= 0);
alter table public.fulfillment add column if not exists easypost_shipment_id text;
create unique index if not exists fulfillment_easypost_shipment_uq
  on public.fulfillment (shop_id, easypost_shipment_id)
  where easypost_shipment_id is not null;
