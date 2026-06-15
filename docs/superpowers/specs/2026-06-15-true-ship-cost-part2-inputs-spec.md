# True Ship Cost — Part 2: Merchant Inputs & Surfaces (sub-spec)

**Date:** 2026-06-15
**Status:** Approved for planning
**Branch:** `feat/true-ship-cost`
**Parent design:** `docs/superpowers/specs/2026-06-15-true-ship-cost-design.md`
**Builds on:** `docs/superpowers/plans/2026-06-15-true-ship-cost-foundation.md` (Plan 1 — the resolver/runner foundation)

## Scope

Plan 1 built the pure resolver, the allocation math, the `order_fact` ship-cost
columns, the `shipping_cost_period` / `shipping_invoice_line` anchor tables, and
the `runShipCostResolution()` runner that writes per-order cost and rolls it into
`sku_pnl`. **Plan 1 produced no way for a merchant to feed the inputs the runner
consumes, and no surface that shows the result.** Part 2 closes that gap:

1. **Settings UI** — a "Shipping cost" section in `app/routes/app.settings.tsx`:
   default mode (`auto` / force Measured / force Reconciled), a Mode-B typed
   period-total entry (amount + carrier + dates → `shipping_cost_period`
   `source='typed'`), and a per-order manual-override correction table.
2. **Manual-override storage (CRITICAL DEPENDENCY)** — Plan 1's resolver reads
   `OrderSignals.manualOverrideCents` but Plan 1 added **no column to store it**
   and the runner hard-codes `manualOverrideCents: null`. Part 2 adds a nullable
   `order_fact.ship_cost_manual_cents` column and rewires the runner to read it.
3. **CSV invoice upload** — a multipart action that parses a carrier/label CSV,
   creates a `shipping_cost_period` (`source='upload'`) + `shipping_invoice_line`
   rows, matches lines to `order_fact` (by `order_number`, else by tracking via
   `fulfillment_fact`), and **surfaces unmatched lines** (never silently drops).
4. **Data-quality nudge** — % of a shop's orders missing weight, shown as a
   Polaris `Banner` in Settings.
5. **Provenance display** — the `ship_cost_source` tag + confidence shown as a
   small Polaris `Badge` next to per-SKU margin/cost in `app/routes/app.skus.tsx`.
6. **(OPTIONAL, deferred-able)** Shopify `shipping_label_created` event parser —
   produces `eventParsedCents`, accepted only when the parsed sum reconciles under
   the period total; malformed messages flagged, never written as `$0`.

After any input change (typed total / upload / override), Part 2 calls
`runShipCostResolution(sb, shopId, { shopCountry })` so margins re-resolve.

## Data contract additions (on top of Plan 1's frozen contract)

New, and the only schema change Part 2 introduces:

- `order_fact.ship_cost_manual_cents integer` — nullable per-order override.
  Migration `supabase/migrations/20260615130000_ship_cost_manual_override.sql`.
  The runner reads it into `OrderSignals.manualOverrideCents`; the resolver's
  existing `manual` precedence (highest) then wins.

Everything else **consumes** Plan 1's frozen names unchanged:
`order_fact.ship_cost_cents | ship_cost_source | ship_cost_confidence |
ship_cost_reconciled_at`, `shipping_cost_period(... source ('upload'|'typed') ...)`,
`shipping_invoice_line(... order_ref, tracking_no, cost_cents, matched_order_id ...)`,
`order_line_fact.grams`, `runShipCostResolution(sb, shopId, { shopCountry })`,
`OrderSignals`, `ShipCostSource`, `ShipCostConfidence`.

New pure helpers (TDD'd, no `.server` suffix — no I/O):

- `app/lib/ship-cost/csv.ts` — `parseInvoiceCsv(text): { rows, errors }`.
- `app/lib/ship-cost/match.ts` — `matchInvoiceLines(parsed, orders): { matched, unmatched }`.
- `app/lib/ship-cost/missing-weight.ts` — `missingWeightPct(orders): number`.
- `app/lib/ship-cost/event-parse.ts` (OPTIONAL) — `parseLabelEvents(messages, periodTotalCents): { eventCentsByOrder, flagged }`.

New server modules (thin I/O wrappers over the pure helpers):

- `app/lib/ship-cost/inputs.server.ts` — `saveTypedPeriodTotal`, `setManualOverride`,
  `ingestInvoiceCsv` (writes rows, then triggers re-resolution).

## UX

In `app/routes/app.settings.tsx`, a new `Layout.AnnotatedSection id="shipping-cost"`
titled **"Shipping cost"** above the existing "Account & data" section, containing:

- **Mode card** — Polaris `Select` (Automatic / Always measured / Always
  reconciled), persisted via a `set_ship_mode` action intent on a `shop_settings`
  row. Help text explains auto-routing.
- **Data-quality `Banner`** — `tone="warning"` when `missingWeightPct > 0`:
  "X% of your orders are missing weight — shipping estimates are degraded.
  Add weights in Shopify to improve accuracy." Hidden at 0%.
- **Period-total card** — `TextField` (amount USD) + `TextField` (carrier) +
  two date `TextField`s; submit intent `add_period_total`. On success a toast +
  re-resolution.
- **CSV upload card** — a file input inside a `Form encType="multipart/form-data"`,
  intent `upload_invoice_csv`. On success, a `Banner` reports matched vs unmatched
  counts; unmatched order refs are listed (rule 12 — fail visibly).
- **Manual-override table** — `IndexTable` of recent orders with an inline
  override `TextField` per row; intent `set_manual_override`. Clearing the field
  (empty) nulls the column.

In `app/routes/app.skus.tsx`, each SKU row gains a small provenance `Badge`
(Actual / Reconciled / Modeled / Fallback) toned by source, with confidence in a
`Tooltip`. Driven by two new `SKU` fields: `ship_cost_source` and
`ship_cost_confidence` (nullable), mapped in `rowToSku`.

## Success criteria

- A merchant can set the shop ship-cost mode and it persists.
- A typed period total writes one `shipping_cost_period(source='typed')` row and
  triggers re-resolution; orders gain `ship_cost_source='reconciled'`.
- A CSV upload writes one `shipping_cost_period(source='upload')` + N
  `shipping_invoice_line` rows; matched lines set `matched_order_id`; **every
  unmatched line is surfaced in the UI** with its order ref.
- A per-order manual override writes `order_fact.ship_cost_manual_cents`; after
  re-resolution that order reads `ship_cost_source='manual'`, confidence `high`.
- The runner reads `ship_cost_manual_cents` into `manualOverrideCents` (the Plan 1
  gap is closed — verified by a runner test).
- The missing-weight banner shows the correct percentage and hides at 0%.
- Each SKU row shows a provenance badge matching its resolved source.
- All pure helpers are unit-tested (Vitest); gate (`typecheck`/`lint`/`build`) green.

## The manual-override dependency (called out explicitly)

> Plan 1 wrote `manualOverrideCents: null` unconditionally in `runner.server.ts`
> and added no storage. Without Part 2's column + runner rewire, the entire
> "manual" precedence tier in the resolver is dead code. **Part 2 Task 2 is the
> hard prerequisite for the Settings override table (Task 5) to have any effect.**
> The migration is additive (nullable column, `if not exists`), so it is safe to
> apply before Plan 1's runner change ships, but the runner edit and the override
> table must land together.

## Deferrals

- Shopify Events-stream parse (Task 9) is **OPTIONAL**; if it ships, it is gated
  on reconciling under the period total and never writes `$0` for malformed input.
- 3PL/carrier API connectors — phase 2 (per master design).
- Multi-package split-shipment per-label modeling — order-level only in v1.
- The `free_shipping_leakage` alert — Plan 3, not Part 2.

## Dashboard parity

Per CLAUDE.md, these merchant-facing additions must mirror onto the `dashboard.*`
surface (`dashboard.api.*` loaders/actions + its own non-Polaris UI), matching the
data contract, not porting Polaris JSX. The mirror is a re-implementation against
the dashboard's `withShopContext` postgres stack: a Shipping-cost settings panel
(mode / typed total / CSV upload / override), the missing-weight nudge, and the
provenance badge in its margin/SKU views. **Part 2's plan ships the Shopify side;
the dashboard mirror is tracked as a single explicit follow-on task (Task 10) so
it is never silently single-sided.**
