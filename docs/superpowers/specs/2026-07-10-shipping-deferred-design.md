# Shipping deferred items — design (2026-07-10)

Follow-up to `2026-07-09-shipping-completion-design.md` (merged PR #417, live-verified).
Builds the items that spec deferred, in value order. Branch `feat/shipping-deferred`.

## D1 — Local pickup
- `ship_rules.pickup_enabled boolean not null default false` (+ optional `pickup_note text`).
- Pickup location = `shop_origin` (one location v1; multi-location routing stays deferred).
- `quoteCartOptions` appends a pickup option when enabled: token `PICKUP::PICKUP`,
  label "Pick up — <origin city>", amountCents 0, ready window = handling days
  (earliest = today + handlingDays, latest = same; copy "Ready <date>").
- `quoteCart` pickup branch: NO carrier engine call, shippingCents 0,
  tax destination = the ORIGIN address (goods change hands at the store),
  destination-country restriction gate skipped (the destination IS the store).
  CartQuote.shippingService = "Store pickup".
- Checkout UI: pickup renders in the same radio list; when chosen, the shipping
  address stays required (buyer identity/contact) but the summary reads
  "Pickup — Ready <date>". Confirmation + emails show "Store pickup".
- Dashboard: toggle on the Shipping screen's Rates & rules card.
- Fulfillment: existing fulfill flow, no tracking; notify email says ready for pickup
  when the order's shipping_service is "Store pickup".

## D2 — Label purchase (EasyPost)
- Order detail (paid/partially_fulfilled orders, shop has `easypost_ship` credential):
  "Buy shipping label" in the fulfill flow. Server: create EasyPost shipment
  (origin = shop_origin, dest = order's buyer shipping address, parcel from the
  order lines' variant_shipping, `options.signature` when any line's variant has
  signature_required), buy the selected rate, persist label.
- Migration: `order_fulfillment.label_url text`, `label_cost_cents int`,
  `easypost_shipment_id text` (idempotency key — never double-buy).
- Buying auto-fills tracking_number + carrier on the fulfillment and reuses the
  existing notify email. Refund-label action deferred to a later slice.
- MONEY: spends the merchant's EasyPost balance. Fail-closed on any ambiguity;
  idempotent on retries (existing shipment id short-circuits).
- Verification: full contract tests with an injectable adapter; a LIVE buy needs a
  merchant EasyPost TEST key (none available in this environment — flagged).

## D3 — Address verification (EasyPost)
- At intent=quote, when a carrier credential exists: EasyPost verify (best-effort,
  non-blocking, 2s budget). Response carries `addressSuggestion` when the verified
  form differs; checkout renders "Use suggested address?" (one click swaps fields).
  No credential / API failure → no suggestion, never a block.

## Still deferred (with reasons)
- Duties/customs: needs an HS-code/landed-cost vendor; no international merchant yet.
- Per-country zone groups beyond domestic/international: no merchant demand yet.
- Label refunds + carrier balance UI: after first real label buys.

## Invariants
- quoteCart stays the single price composer; pickup is a branch INSIDE it, not a bypass.
- Engine contract untouched (pickup never reaches the rate engine).
- Money paths idempotent + fail-closed; every write same-origin + session-guarded.
- Migrations checked in + applied to prod before merge.
