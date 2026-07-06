# Payment-gate test transaction — design

**Date:** 2026-07-06
**Surface:** dashboard Cutover screen + cutover server lib (platform pivot Step 9)
**Status:** approved design, pre-implementation

## Problem

The go-live gate (`app/lib/cutover/go-live.server.ts`) has two payment-cleared
checks:

| check | passes when |
|-------|-------------|
| `paid_order` | ≥1 row in `orders` with `state='paid'` |
| `captured_charge` | ≥1 row in `transaction_ledger` with `kind='capture'` |

Both sit red at 0/0 for every merchant, because nothing produces a test
payment during `dual_run` and the Cutover screen only *displays* the checklist.
A merchant has no path to green — they cannot cut over.

## Principle: reuse, don't build

The money path already works end to end. A completed Stripe checkout fires
`payment_intent.succeeded` → the existing webhook (`processStripeEvent` in
`app/lib/payments/stripe.server.ts`) flips the order to `paid` **and** writes
the `capture` ledger row. Both gate checks turn green with **zero new payment
logic.** This feature is only: (1) a guided way to originate one minimal real
Stripe charge, and (2) honest cleanup afterward.

## Approach: a 50¢ payment probe, refunded at cutover

Not a real product purchase. A dedicated **payment probe**: a minimal owned
order charged the Stripe minimum, proven paid through the real webhook, then
refunded after go-live commits.

### Why a probe, not a real cart checkout

- `createCheckout()` is cart/variant based, computes the real cart total, and
  reserves inventory — the wrong tool for a fixed token charge (real money,
  real stock decrement, restock needed).
- A probe touches **no variant and no inventory**, so there is nothing to
  restock. Cleanup is a single refund.

### The charge amount

Stripe rejects charges below its per-currency minimum (**$0.50 USD**; "1 cent"
is not chargeable). The probe charges the Stripe minimum for the shop currency
(50¢ USD equivalent), fully refunded — the merchant nets zero.

## Components

### 1. Tag — `channel='test'`
The probe order carries `channel='test'`. **No migration:** `orders.channel`
already exists (`text NOT NULL default 'storefront'`, app-level vocabulary,
added in `20260630120000_agentic_order_channel.sql`).

### 2. `startTestTransaction(shopId)` — new `app/lib/cutover/test-transaction.server.ts`
- Guard: shop is in `dual_run` (the only stage where a go-live test makes
  sense). Reject otherwise with a clear message.
- Guard: Stripe Connect is set up for the shop (`payments/connect.server.ts`).
  If not, surface **"Connect Stripe before running a test transaction"** — do
  not throw a raw Stripe error (rule 12).
- Insert a minimal `orders` row directly (mirrors the insert in
  `checkout.server.ts:164`): `state` defaults to `checkout_pending`,
  `channel='test'`, `subtotal_cents=<min>`, `shipping_cents=0`, `tax_cents=0`,
  `total_cents=<min>`, shop currency, a fresh `confirmation_token`, and a guest
  buyer via `upsertGuestBuyer` (test email). **No order lines, no
  `reserveInventory`.**
- Reuse `createCommerceCheckoutSession(shopId, { orderId, totalCents,
  currency, confirmationToken })` → real Stripe Checkout URL.
- Return `{ url }`.

### 3. Webhook — one reconciliation branch added
`processStripeEvent` clears the probe via `metadata.order_ref` (set by
`createCommerceCheckoutSession`), flipping the order `paid` and writing the
`capture` ledger row with no dependence on order lines.

**Correction (found in final review):** hosted Stripe Checkout never pre-creates
a `payment_intent` DB row (only the Payment Element path did), so
`payment_intent.succeeded` hit the RPC's `payment_intent not found` raise and
500-looped — the probe never reached `paid`. Fix: a `checkout.session.completed`
branch in `processStripeEvent` reconciles (idempotent upsert) the
`payment_intent` row from the completed session before the paired
`payment_intent.succeeded` event does the capture/transition. Single-capture
invariant preserved (only the PI event writes the ledger). **Ops requirement:**
the Stripe webhook endpoint must be subscribed to `checkout.session.completed`
in addition to `payment_intent.*`.

### 4. Cutover UI — `app/components/dashboard/screens/Cutover.tsx`
A card beneath the two payment checks: **"Run a test transaction"** button →
POST to a dashboard action route → open the returned Stripe URL in a new tab.
The checklist refreshes (light poll / revalidate on the existing loader) so the
two payment checks flip to green within seconds of the webhook landing.

### 5. Post-cutover cleanup — hook in `transitionOrgMode`
In `app/lib/cutover/org-mode.server.ts`, immediately after the `→ live`
compare-and-set commits (beside `stampMigrationRunCutover`): sweep
`channel='test'` orders still in `state='paid'` for the shop and full-refund
each via the existing `app/lib/actions/refund.server.ts` path (refund moves the
order `paid → refunded` and writes the negative ledger row).

**Fail-loud but non-blocking (rule 12):** go-live has already committed, so a
refund failure must **log loudly + write an audit row**, never throw past the
committed live transition and never silently swallow. The captured `capture`
row persists regardless, so `captured_charge` stays satisfied; `paid_order`'s
purpose is already served (it was green at the moment the gate ran).

### 6. Analytics exclusion
Exclude `channel='test'` from revenue/order analytics reads so the probe never
shows as sales. Small filter at the analytics query boundary.

## Data flow

```
merchant (dual_run) clicks "Run a test transaction"
  → startTestTransaction(shopId)
      guards: dual_run + Stripe connected
      insert orders{ channel:'test', total_cents:min, state:checkout_pending }
      createCommerceCheckoutSession → Stripe URL
  → merchant pays 50¢ with a real card on Stripe-hosted page
  → Stripe payment_intent.succeeded → processStripeEvent (existing)
      orders → paid ; transaction_ledger += capture
  → gate re-runs: paid_order ✓  captured_charge ✓  (checklist shows green)
  → merchant clicks Go live → transitionOrgMode(... → live)
      assertGoLiveGates passes (probe order is paid) → compare-and-set commits
      → stampMigrationRunCutover + sweep channel='test' paid orders → refund each
```

## Error handling (fail visibly — rule 12)

- Not in `dual_run` → reject before any write, clear message.
- Stripe not connected → clear "connect Stripe first" message, no raw error.
- Stripe session creation fails → surface Stripe's message; no orphan order left
  in a misleading state (the probe order stays `checkout_pending`, ignorable).
- Cleanup refund fails → log with the order id + Stripe context, write audit,
  do **not** roll back the committed live move.

## Success criteria

- A `dual_run` merchant clicks the button → real Stripe page → real card → both
  payment checks flip green within seconds.
- `→ live` succeeds; immediately after, every `channel='test'` order shows
  `refunded`, money netted to zero.
- No `channel='test'` order appears in revenue analytics.

## Tests (behavior, not theater)

- `startTestTransaction`: creates an order tagged `channel='test'` with the
  minimum total and returns a Stripe URL (Stripe mocked); rejects when the shop
  is not in `dual_run`; surfaces a clear error when Stripe is not connected.
- cleanup sweep: refunds every `channel='test'` order in `paid`; on a refund
  failure, logs loudly + audits and does **not** throw past the committed live
  move.
- (gate counting itself is already covered by `go-live.server.test.ts`.)

## Out of scope

- Test-mode Stripe keys / `4242` card path (design chose live-mode real charge).
- Multi-currency minimum tuning beyond "use the shop currency's Stripe minimum."
- Any change to the gate's counting logic.
```
