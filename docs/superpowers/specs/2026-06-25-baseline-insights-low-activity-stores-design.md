# Baseline insights for low-activity stores

Date: 2026-06-25
Status: Approved design, pending implementation plan

## Problem

When a merchant installs Calderyn on a store with no ad spend and little or no
order history, the main page shows "Money at risk: $0" and "First scan in
progress," then never fills in. Investigation confirmed the cause: all 14
existing engine detectors require order history (or order-derived data such as
sales velocity, margins, or ad attribution). Not one can fire on catalog and
inventory alone. So a new or low-traffic merchant sees an empty product with no
next action and churns.

## Goal

Give any store, including one with zero orders and zero ads, something useful and
honest on the main page from day one, by making the engine smarter rather than
redesigning the UI.

## Non-goals

- No UI redesign. The "Money at risk" card stays exactly as it is.
- No new merchant data-entry flows. We use what Shopify already exposes; if cost
  is blank we nudge, we do not block.
- No velocity/overstock/demand work. Those genuinely need orders and are already
  covered by existing detectors once orders exist.

## Approach: engine-side, additive

Add a new "baseline" class of detectors to the existing engine that read
catalog / inventory / cost instead of orders, and write into the same alerts
pipeline. Chosen over computing tips in the UI because it matches the request (a
smarter engine), reuses the existing alerts table, the Claude rank-and-narrate
step (which tells the merchant what to do), and the automatic mirror to the
dashboard, and it never touches the existing 14 detectors, so it cannot break
stores that already work.

```
  Shopify backfill --> sku_dim (+ new: retail_price_cents, unit_cost_cents,
                       product status), inventory_level_fact, location_dim
                              |
                              v
              [ NEW: baseline detectors ]   runs even with no order data
                              |
                              v
              same Claude rank + narrate step
                              |
                              v
                       alerts table --> existing "top alerts" list populates
```

## Data prerequisite

Margin checks need per-SKU price and cost, which a zero-order store does not have
today (price comes from order lines, cost from order-line snapshots). Both are
available from the Shopify Admin API without merchant input.

1. Add nullable columns to `sku_dim`: `retail_price_cents`, `unit_cost_cents`,
   and a product status field (e.g. `product_status`) so we only flag live
   products.
2. Backfill capture:
   - `app/lib/ingest/shopify-admin.server.ts` `fetchProducts`: add variant
     `price` to the query (we already fetch `inventoryItem.unitCost`; persist it)
     and product `status`.
   - `app/lib/ingest/mappers.server.ts` `mapVariantToSku`: map price, unit cost,
     and product status onto the SKU row.
3. Migration via `prisma migrate dev` / Supabase migration. Additive, nullable,
   so existing rows and detectors are unaffected.

## Baseline detectors

Two sets, registered like existing detectors in
`engine/calderyn_engine/detectors/`.

### Inventory set (needs nothing entered, works for every store)

| Detector | Fires when | Merchant-facing line |
|---|---|---|
| out_of_stock_live | product is live and total available <= 0 | "N live products cannot be bought right now" |
| inventory_untracked | variant has inventory tracking off | "You are flying blind on stock for N products" |

### Margin set (uses the captured price + cost)

| Detector | Fires when | Merchant-facing line |
|---|---|---|
| priced_below_cost | retail_price_cents < unit_cost_cents | "You lose $X every time this sells" |
| thin_margin | margin percent < THIN_MARGIN_PCT (default 15%) | "N products barely break even before shipping and fees" |
| missing_cost | unit_cost_cents is null | "Add costs on N products so Calderyn can watch your margins" |

`missing_cost` is the activation nudge: filling cost unlocks the other margin
checks and the order-based margin detectors later.

Thresholds (THIN_MARGIN_PCT, minimum-product-count to bother firing, etc.) live
as named constants, consistent with existing detectors.

## How findings surface, and honest numbers

- Findings flow through the existing rank-and-narrate step and land in the
  existing "top alerts" list, each with a plain-English "what to do." This alone
  removes the "First scan in progress" empty state and gives a new merchant clear
  next actions.
- The "Money at risk" hero stays honest and unchanged. It sums only `critical`
  realized risk. Baseline findings are never `critical`, so they populate the
  list without inflating the hero. A store with no sales is not actually bleeding
  the below-cost money yet, so we do not book it as critical.
- Per-detector severity: baseline detectors emit `high` / `medium` / `low`, never
  `critical`. `dollar_impact` reflects an honest figure for the row (for example
  per-sale loss for `priced_below_cost`), framed as a rate in the narrative, not
  as money currently being lost.

## Engine must run for zero-order stores

Confirm the pipeline (`engine/calderyn_engine/pipeline.py`, triggered via
`/cron/detect` and `api/engine/run.py`) actually executes for a store with no
orders. If it currently short-circuits empty stores, add a small additive trigger
so baseline detectors run. This is the one feasibility item to verify first
during implementation.

## Auto-resolution

Baseline alerts must clear when the condition is fixed (stock returns, cost
added, price corrected), the same way existing detectors resolve. Reuse the
existing stale-alert resolution path; entity dedup key stays `(shop_id,
detector_id, entity_ref)` with `entity_ref = {sku_id, sku}`.

## Dashboard parity

Because the work is entirely in the shared engine and the shared alerts table,
both the embedded app and the dashboard pick it up with no per-surface UI change.
No separate dashboard mirror is needed.

## Sequencing

1. Data prerequisite (price + cost + status capture, migration).
2. Inventory set (guaranteed value for every store, needs no cost).
3. Margin set (richer money framing, depends on step 1).

## Testing

- Python unit tests per detector with fixtures of sku + inventory + cost rows and
  zero orders, asserting fire / no-fire and the computed impact.
- A pipeline test proving the engine runs and emits baseline alerts for a
  zero-order store.
- A resolution test proving an alert clears once its condition is fixed.
- TypeScript: backfill mapper test asserting price / cost / status are persisted.

## Open items to confirm during implementation

- Whether the engine pipeline currently runs for zero-order stores (see above).
- Exact Shopify field for product status in the backfill query and its mapping.
- Final thresholds for thin margin and minimum counts.
