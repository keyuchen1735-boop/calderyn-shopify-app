# Shipping completion — design (2026-07-09)

Goal: bring the shipping surface to parity-or-better vs Shopify for the native platform.
Verified baseline (all paths read on `origin/main` @ c3ecf8e8):

- Quote engine (`app/lib/shipping/engine.impl.server.ts`) is solid: live EasyPost rates,
  static fallback bands, per-variant restrictions, delivery windows, tenant-scoped cache.
- `MerchantShipRules` (markup / handling fee / free-ship threshold) is fully implemented in
  `rules.ts` + tested, but **no runtime caller passes rules** (`quote.server.ts:62`,
  `estimate.server.ts:96`, `carrier-service.server.ts` callback). No storage, no UI.
- Checkout (`storefront.checkout.tsx`) handles OutOfStock / PaymentsNotReady /
  ShipRestricted / OriginNotConfigured, but `RATE_SOURCE_NOT_CONFIGURED` → generic 502,
  restricted errors don't name items, and the buyer never chooses a shipping option
  (`selection: "cheapest"` forced).
- `getRateSource` throws when EasyPost isn't connected → a merchant who never pasted an
  EasyPost key loses every checkout.
- Origin: auto-cached from Shopify only; no merchant editor (Shipping screen copy claims
  onboarding sets it — false).
- `variant_shipping.handling_days` persisted but unread (windows use fixed 1 day);
  `signature_required` has no consumer (reserved for future label purchase).
- Storefront checkouts never lock quotes → Shipping screen 30d stats cover only
  agentic/ACP surfaces.
- Fulfillment/tracking/packing slips/notify email: MERGED on main (#399/#411/#403/#409).
  Shipping email prints tracking as plain text (no URL). Confirmation page shows lines +
  totals (incl. shipping row) but no service name.

## Scope (this branch, `feat/shipping-completion`)

### P1 — Checkout safety & clarity
1. Catch `RateSourceNotConfiguredError` in the checkout action → honest 503 (kept as a
   safety net; P5 makes it near-unreachable).
2. `ShipRestrictedError` handler names the blocked items (resolve `err.variantIds` →
   cart line titles) so the buyer knows what to remove. Same for the delivery-promise
   API (distinct copy for restricted vs no-estimate).
3. Country input → `<select>` over the full ISO-3166 list (client-importable constant),
   replacing the "2-letter code" text field. Kills the toIsoCountry 400 path for buyers.

### P2 — Merchant ship rules (the free-shipping unlock)
1. Migration `ship_rules`: shop_id PK → shops, markup_pct numeric, handling_cents int,
   free_ship_threshold_cents int null, handling_days int default 1, updated_at. RLS
   shop-scoped (mirror `variant_shipping` policy shape).
2. `app/lib/shipping/rules.server.ts`: `loadShipRules(shopId)` → `MerchantShipRules`
   (+ handlingDays), `saveShipRules`.
3. Contract: add optional `handlingDays?: number` to `MerchantShipRules` (additive).
   Engine uses `rules?.handlingDays ?? deps.handlingDays` for delivery windows.
   Cache key already derives from rules keys (`canonicalRules`) — no cache change.
4. Pass rules at all three call sites: `quoteCart`, `estimateShipping`, carrier-service
   callback. Effective handling days = max(shop rule, max `variant_shipping.handling_days`
   across the cart) — batched read piggybacked on the existing restriction query.
5. Shipping screen "Rates & rules" card: markup %, handling fee, free-shipping-over,
   ships-within-days. Writes via new `action` on `dashboard.api.shipping`
   (`requireSameOrigin` + intents, mirroring `dashboard.api.ship-cost.tsx`).
6. Cart page free-shipping progress: when a threshold is set, show "Add $X more for free
   shipping" / "You've unlocked free shipping" on `storefront.cart.tsx`.

### P3 — Ship-from origin editor
Shipping screen origin card becomes editable (street, city, state, zip, ISO country) →
intent `set_origin` writes `shop_origin` with `source: 'merchant'`. Fix the misleading
empty-state copy. Native-only shops (no Shopify import) finally get a way to quote.

### P4 — Buyer shipping choice at checkout
1. `quoteCartOptions(shopId, lines, dest)` in `app/lib/commerce/quote.server.ts`:
   selection "all", returns deduped options (≤5, sorted by price, fastest always
   included) with service, carrier, label, amountCents, delivery window.
2. Checkout becomes: address → intent `quote` (no writes) → option radio list with
   arrival dates ("Arrives Jul 14–16") → intent `pay` with chosen service →
   `createCheckout(..., { shippingService })`.
3. `createCheckout` re-quotes with `serviceFilter: [service]`; if the engine's returned
   option doesn't match (rate vanished / degraded to fallback), throw typed
   `ShippingOptionUnavailableError` → route re-offers fresh options. No selection posted
   → cheapest (current behavior).
4. Migration: `orders.shipping_service text null`; persisted at insert; surfaced on the
   confirmation page ("Shipping (USPS Priority)").
5. Lock the winning quote into `commerce_quote_fact` (best-effort, non-fatal) so the
   Shipping screen's 30d stats finally include storefront checkouts.

### P5 — Rates out of the box (flat rates without a carrier)
1. Migration `ship_flat_rate`: id, shop_id, label, zone ('domestic'|'international'|'all'),
   max_weight_oz numeric null (null = top band), amount_cents, est_transit_days int null,
   position int. RLS shop-scoped.
2. `getRateSource` resolution becomes: EasyPost connected → live rates; else merchant
   flat table (source id `flat:{shopId}:{version}` so edits bust the engine cache,
   fallbackUsed=false — these are authoritative merchant rates); else built-in default
   bands (fallbackUsed=true — honest "not configured" signal). **Never throws**: a new
   store can take its first order with zero shipping setup.
3. Zone match: destination country === origin country → domestic, else international;
   'all' rows always match.
4. Shipping screen "Flat rates" editor (add/edit/delete rows) + copy that live carrier
   rates take over when EasyPost is connected. Rate-card table shows the merchant's real
   active rate source.

### P6 — Buyer tracking & post-purchase polish
1. `carrierTrackingUrl(carrier, trackingNumber)` map (USPS/UPS/FedEx/DHL/Canada Post →
   URL, else null). Shipping-confirmation email links the tracking number (HTML);
   plain-text keeps the raw number.
2. Order detail fulfillments card links tracking numbers the same way.
3. Confirmation page: show shipping service name; buyer account list already maps
   fulfilled → "Shipped" (now reachable — no change needed).

### P7 — Shipping screen truthfulness
Render `lowConfidenceSharePct` (already computed server-side), reflect the active rate
source in the rate-card header, drop stale placeholder copy where the feature now exists.

## Explicitly out of scope (documented, deliberate)
Label purchase (EasyPost buy flow), local pickup/delivery, duties/customs, address
verification APIs, multi-parcel packing, per-country zone groups beyond
domestic/international, `signature_required` consumer (reserved until labels exist).

## Invariants that must hold
- Money is integer cents everywhere; no negative charges (rules clamp at 0).
- quoteCart stays THE single price composer; no surface re-computes price.
- Engine never throws / never returns empty options.
- Fail-closed restriction gate unchanged (`restrictedVariants`; missing row = unrestricted).
- Tax keeps covering shipping (Stripe Tax `shipping_cost`); tax failure still fails the quote.
- Every dashboard write: `requireSameOrigin` + `requireDashboardSession`; shop from session.
- Migrations checked in + applied to prod (supabase MCP) before merge.
