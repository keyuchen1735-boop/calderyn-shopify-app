# True Ship Cost — design spec

**Date:** 2026-06-15
**Status:** Approved for planning
**Branch:** `feat/true-ship-cost`

## Problem

Calderyn computes contribution margin without ever knowing what the merchant
actually paid to ship an order. Two facts establish this:

- `OrderRow.shipping_cents` (`app/lib/seed/types.ts:35`, ingested at
  `app/lib/ingest/mappers.server.ts:76` from Shopify's `totalShippingPriceSet`)
  is **what the customer paid** for shipping — a revenue-side number.
- Contribution margin is defined as
  `revenue − cogs − ad_spend_attrib − returns` (`SkuPnlRow`,
  `app/lib/seed/types.ts:97-101`; campaign-level mirror in the `campaign_grade`
  migration). **There is no carrier/label cost term, and no field stores what
  the merchant paid the carrier.**

Consequence: a free-shipping order that cost $4.50 to ship and one that cost
$100 are identical to the engine — both overstate margin by the full carrier
cost. The common workaround (bake one flat "average shipping cost" into COGS)
is the same blindness in disguise: it cannot capture the per-order variance
that weight and destination produce, which is exactly what swings $4.50 → $100.

## Goal

Produce a trustworthy **per-order `ship_cost`**, stamped with a provenance tier
and confidence, and feed it into the contribution-margin formula — for **every**
merchant, not only the Shopify-Shipping minority.

```
contribution_margin = revenue − cogs − ad_spend − returns − ship_cost
net_shipping_pnl     = shipping_cents (customer paid) − ship_cost   ← leakage signal
```

Success criteria:

- Every order carries `ship_cost_cents`, `ship_cost_source`,
  `ship_cost_confidence`.
- Per-order ship costs in a billing period **sum to the merchant's real total**
  whenever a total is known (anchored to truth, not fabricated).
- Contribution-margin reads (order, SKU, campaign) subtract `ship_cost`.
- A merchant can see, per order/SKU, which tier produced the number and how
  confident it is.
- One alert surfaces free-shipping leakage by SKU/zone cluster, gated so it only
  fires on trustworthy aggregates.

## Core principle

> **The period total always anchors. Per-order actuals refine _within_ that
> total when a trustworthy source exists, reconciled so they can never
> contradict the real total.**

This inverts the naive "chase ever-more-precise per-order actuals, fall back to
a generic rate card" waterfall. The genuinely obtainable ground truth is not
per-order label cost (Shopify does not hand that to apps cleanly) — it is the
**period total** the merchant paid (a carrier invoice, the Shopify Shipping bill
line, or a number typed once). Per-order cost becomes an _allocation of a known
total_, calibrated to that merchant's real negotiated rates and surcharges.

## Two modes (per-order auto-routed, overridable in Settings)

A given shop often mixes fulfillment methods, so the mode is resolved **per
order**, with a shop-level default and manual override in Settings — never a
single global toggle that would re-blind half a mixed shop's orders.

- **Mode A — Measured.** A real per-order/per-shipment cost exists. v1 source
  priority:
  1. **Carrier/label invoice upload (CSV)** — the merchant's real, itemized
     spend matched per order/tracking number. Works for every carrier including
     Shopify Shipping. No integration to build. **Primary v1 source.**
  2. **Shopify Events-stream parse** (`"A $5.75 label was created"` in the order
     timeline) — automatic for Shopify-Shipping shops, but a fragile text parse.
     **Optional auto-enhancement, never load-bearing**; only trusted when it
     reconciles under the period total.
  3. **3PL/carrier API connectors** (ShipStation/EasyPost/Shippo/ShipBob) —
     cleanest automatic per-shipment cost. **Deferred to phase 2** (growth-lever
     upgrade, not a v1 dependency).

- **Mode B — Reconciled.** No per-order data exists (own carrier account,
  self-fulfilled, flat-rate). Take the known period total and **allocate it per
  order by weight × zone**, normalized so the allocation sums to the real total.
  Degrades along one axis: full features → fitted per-order distribution; no
  features → the merchant's _real_ average (anchored to actual spend, honest);
  the flat average is the explicit floor, not a hidden default.

Both modes write the **same** `ship_cost_cents` + provenance field, so the
margin formula and alerts downstream are mode-agnostic.

## Data model (new)

- `orders.ship_cost_cents` (resolved per-order cost)
- `orders.ship_cost_source` — enum:
  `actual_invoice | actual_event | reconciled | modeled | fallback | manual`
- `orders.ship_cost_confidence` — `high | med | low`
- `orders.ship_cost_reconciled_at` — timestamp of last resolution
- `shipping_cost_period` — the Mode-B anchor:
  `shop_id, period_start, period_end, carrier, total_cents, source(upload|typed),
  created_at`
- `shipping_invoice_line` — Mode-A actuals from an upload:
  `shop_id, period_id, order_ref/tracking_no, cost_cents, matched_order_id`
- **Weight (in v1):** add `order_lines.grams` (+ `skus.grams`), ingested from the
  Shopify line-item `grams` field already present in the GraphQL payload. Weight
  × zone is the mechanism that captures the $4.50-vs-$100 swing; without it Mode
  B degrades to item-count and barely beats a flat average. Cheap to add — the
  field is already in the response.

All schema changes go through `prisma`/Supabase migrations per repo convention;
the order/SKU/PnL margin tables and the `alerts` table live in Supabase
(postgres), with margin exposed through a view and alerts through `v_alerts_view`
owned by the `cron.detect` detector.

## Resolution engine (`app/lib/ship-cost/`)

Pure and unit-tested. Input: an order (+ its lines, destination zone, weight) +
the shop's period anchor + any matched invoice line + any parsed event + any
manual override. Output: `{ ship_cost_cents, source, confidence }`.

Auto-routing precedence (top-down, first match wins):

1. **Manual override** present → `manual`.
2. **Matched invoice line** (Mode A primary) → `actual_invoice`, high.
3. **Reconciled event-parse** value that fits under the period total (Mode A
   bonus) → `actual_event`, med.
4. **Mode B allocation** of the period total → `reconciled`; confidence scales
   with feature coverage (weight present, zone known, package count).
5. No period total at all → `modeled` (generic per-zone default) → `fallback`
   (flat). Low confidence.

## Allocation math

Two distinct allocations, both stated explicitly:

- **Total → order.** Allocation key = `weight_share × zone_multiplier ×
  package_count`, normalized so **Σ order costs = period total** (anchored to
  truth). No weight → item-count share. Package/fulfillment count multiplies
  where known.
- **Order → SKU/line.** Split each order's `ship_cost` across its line items
  **by line-weight share, else by quantity share.** This feeds per-SKU margin
  and the SKU-cluster leakage alert. (Chosen weight→quantity over by-value; the
  cost driver is mass/size, not price.)

## Reconciliation / restatement

No provisional/settled state machine. The resolver re-runs for a period on:
order ingest, invoice/total upload, and the nightly `cron.detect`/ingest pass.
When a new total lands, that period's margins update and `ship_cost_reconciled_at`
is stamped; the UI shows a "last reconciled" line so the change is **visible,
not silent**. Restatement falls out of re-running allocation — no per-order
finality flags.

## Settings + auto-routing config

Embedded admin (Polaris, `app/routes/app.settings.tsx` neighborhood):

- Default mode: `auto` (recommended) / force Mode A / force Mode B.
- Mode-B period total: typed figure **or** CSV upload (carrier + period).
- Per-order correction table (manual override → `source = manual`).
- Allocation-key preference (auto: weight → count).
- **Data-quality nudge:** "X% of orders missing weight → shipping estimates
  degraded" — drives the confidence tier and gives the merchant a concrete fix.

## Alert (one, confidence-gated)

`free_shipping_leakage`: SKU-cluster / zone-band where
`shipping_revenue − ship_cost` is deeply negative. **Fires only when the
cluster's aggregate confidence clears a bar**, so it alerts on the anchored
aggregate even when single-order allocations are fuzzy. Slots into the existing
`alerts` table + `cron.detect` + `propose_action` flow (propose: raise the
free-ship threshold / exclude a heavy SKU, with undo).

Deferred to phase 2: threshold mispricing, ship-cost variance (Tier-1 vs model
divergence), adjustment-drift.

## Provenance display

Each order/SKU margin carries its source tag (Actual / Reconciled / Modeled /
Fallback) + confidence, so the merchant trusts the number and sees that
uploading an invoice or connecting a carrier upgrades fidelity (growth lever).

## Dashboard parity

Mirror the contract on the `dashboard.*` surface: a ship-cost column in its
margin views, the Settings controls (total / upload / override) in its own UI
primitives, and the leakage alert in its alerts surface — re-implemented against
the dashboard's postgres / `withShopContext` stack, **matching the data
contract, not porting Polaris JSX.**

## Scope boundaries (deferred, named)

- 3PL/carrier API connectors (ShipStation / EasyPost / Shippo / ShipBob).
- Full provisional/settled temporal versioning of margin.
- Multi-package split-shipment per-label modeling (v1 allocates at the order
  level; split shipments are approximated, limitation noted in UI).
- The three secondary alerts (threshold mispricing, variance, adjustment drift).

## Testing

- **Resolver (pure) unit tests:** allocation **sums to the period total**;
  routing precedence (manual > invoice > event > allocation > modeled >
  fallback); confidence tiers; order→SKU split (weight then quantity); graceful
  degradation when weight is missing.
- **CSV ingest:** parse + per-order/tracking match; unmatched lines surfaced,
  not dropped.
- **Event-parse:** only accepted when it reconciles under the period total;
  malformed messages flagged for review, never silently written as $0.
- **Alert:** confidence gate (no fire below the bar); leakage clustering by
  SKU/zone.
- **Reconciliation:** re-run idempotency; margin restatement when a new total
  lands.

## Open implementation-time lookups (resolve during planning)

- Exact Supabase view/RPC that computes `contribution_margin_cents` (so the
  ship-cost term is added in the right place).
- Exact `alerts` table columns + `alert_kind` constraint (to add
  `free_shipping_leakage`).
- The Shopify GraphQL field path for line-item `grams` in the current ingest
  query.
- Zone bucketing for `zone_multiplier`, derived from the order's existing
  `customer_country` / `customer_region` (e.g. domestic / continental /
  international) — decide the bucket set and default multipliers.
