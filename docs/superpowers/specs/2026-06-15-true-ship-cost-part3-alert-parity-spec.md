# True Ship Cost — Part 3 sub-spec: free-shipping-leakage alert + dashboard parity

**Date:** 2026-06-15
**Status:** Approved for planning
**Branch:** `feat/true-ship-cost`
**Parent:** `docs/superpowers/specs/2026-06-15-true-ship-cost-design.md` (master design, "Alert" + "Dashboard parity" sections)
**Builds on:** `docs/superpowers/plans/2026-06-15-true-ship-cost-foundation.md` (Plan 1 — consumes its frozen contract)

## Problem

Plan 1 produces a trustworthy per-order `ship_cost_cents` (with `ship_cost_source` /
`ship_cost_confidence`) and subtracts it from contribution margin. But the merchant
still has no signal that a *specific* SKU or shipping zone is bleeding money on
**free-shipping** orders — the orders where `shipping_cents` (what the customer paid)
is ~0 while the resolved `ship_cost_cents` (what the merchant paid the carrier) is
large. Aggregated across many orders, a single heavy SKU shipped free to a distant
zone can quietly erase the margin Plan 1 just made visible.

The master design names exactly one alert for v1 (the other three are deferred):

> `free_shipping_leakage`: SKU-cluster / zone-band where `shipping_revenue −
> ship_cost` is deeply negative. **Fires only when the cluster's aggregate
> confidence clears a bar.**

## Goal

Ship, end to end and on **both surfaces** (embedded Polaris admin + dashboard):

1. A new `free_shipping_leakage` detector that clusters free-shipping orders by SKU
   and by zone band, computes the aggregate net-shipping bleed, gates on aggregate
   ship-cost confidence, and upserts an `alerts` row (idempotent on the ongoing
   condition).
2. Two `propose_action` actions on that alert — **raise the free-ship threshold**
   and **exclude a heavy SKU from the free-ship promo** — both reversible (undo),
   slotting into the existing action / audit / undo flow.
3. Dashboard parity: a net-shipping-P&L column with provenance tag in the dashboard
   Analytics surface, plus the leakage alert and its provenance rendered in the
   dashboard alerts surface — built against the dashboard's own primitives.

### Success criteria

- A shop with anchored (high/med-confidence) free-shipping orders that bleed money
  on a SKU or zone produces a `free_shipping_leakage` alert with the correct
  `dollar_impact` (the bleed), `severity` (by magnitude), `entity_ref`
  (`{kind:'sku'|'zone', id, ...}`), and `day_bucket`.
- The detector does **not** fire when the cluster's aggregate confidence is below the
  bar (majority `low`/`fallback`), even if the apparent bleed is large.
- Re-running the detector on the same standing condition refreshes the **same** alert
  row (no per-day pile-up), keyed off `(shop_id, detector_id, entity_ref)`.
- The merchant can, from either surface, propose **raise free-ship threshold** or
  **exclude SKU from free-ship**, see the action recorded in the audit log, and undo
  it; the undo re-opens the alert.
- The dashboard Analytics view shows, per SKU, net shipping P&L
  (`shipping_cents − ship_cost_cents`) with the provenance tag (Actual / Reconciled /
  Modeled / Fallback), using Lucide via `CDIcon` — never Polaris.
- The embedded-admin alert renders through the existing generic alert UI with no
  bespoke component (point 4 confirmed: it is just another `detector_id`).

## Frozen contract consumed (from Plan 1 — do not rename)

- `order_fact.ship_cost_cents`, `order_fact.ship_cost_source`,
  `order_fact.ship_cost_confidence` (text + CHECK; values
  `actual_invoice|actual_event|reconciled|modeled|fallback|manual` and
  `high|med|low`).
- `order_fact.shipping_cents` (what the **customer** paid — already existed),
  `order_fact.customer_country`, `order_fact.customer_region`.
- `order_line_fact.grams`, `sku_dim.grams`.
- `sku_pnl.ship_cost_cents` and `sku_pnl.contribution_margin_cents` (now net of ship
  cost) — Plan 1 Task 8/9.
- `app/lib/ship-cost/zone.ts`: `classifyZone(shopCountry, orderCountry)` →
  `"domestic"|"continental"|"international"`.

## Detector logic (`free_shipping_leakage`)

A new **`detector_id` string** — NO enum migration (the `alerts` table stores
`detector_id` as `text`; see ALERTS TABLE SCHEMA note in the design). The detector is
a TS module split into a **pure clustering/threshold core** (unit-tested) and a thin
**Supabase I/O wrapper** (tested with a fake client), mirroring the
`app/lib/ship-cost/runner.server.ts` split from Plan 1 Task 9.

### Inputs (one row per order, already resolved by Plan 1)

```
ShipLeakOrder = {
  orderId: string;
  skuIds: string[];          // SKUs on the order (from order_line_fact → sku_dim)
  shippingCents: number;     // order_fact.shipping_cents (customer paid)
  shipCostCents: number;     // order_fact.ship_cost_cents (merchant paid, resolved)
  shipCostConfidence: "high" | "med" | "low";
  zone: "domestic" | "continental" | "international";  // classifyZone(shop, order)
}
```

Plus, for the SKU clustering, the per-order ship cost is **split across the order's
lines** using Plan 1's `splitOrderShipCost()` so a multi-SKU order attributes the
right share of the bleed to each SKU (weight share, else quantity share). The same
split is applied to `shippingCents` so the per-SKU net is apples-to-apples.

### Free-shipping filter

An order counts as "free shipping" when `shippingCents <= FREE_SHIP_THRESHOLD_CENTS`
(default `100` = $1.00 — covers true $0 and trivial handling fees). Orders above the
threshold are ignored (the merchant charged for shipping; not leakage).

### Clustering

Two independent cluster sets from the free-shipping orders:

- **By SKU** — group the per-line splits by `sku_id`. Each cluster aggregates
  `Σ(line_shipping_share − line_ship_cost_share)` and tracks the confidence mix of the
  contributing orders.
- **By zone band** — group whole orders by `zone`. Each cluster aggregates
  `Σ(shippingCents − shipCostCents)` and the confidence mix.

A cluster's **net** is its aggregate `shipping − ship_cost` (negative = bleed). The
**bleed** reported as `dollar_impact` is `max(0, −net)` (only negative nets are
leakage; positive nets are fine and never alert).

### Confidence gate (the bar)

A cluster fires **only** when its aggregate confidence clears the bar:

> **majority of the cluster's ship-cost dollars come from `high` or `med`
> confidence orders** — specifically `(high_dollars + med_dollars) / total_ship_cost_dollars >= 0.5`,
> AND at least one contributing order is `high` or `med`.

This is dollar-weighted (not order-count-weighted) so one big fuzzy order can't drag a
well-anchored cluster below the bar, and a pile of tiny fuzzy orders can't fabricate a
fire. Clusters that are majority `low`/`fallback` are **skipped** (logged at debug, not
alerted) — the alert speaks for anchored aggregates only, per the design.

### Magnitude → severity

By the cluster's bleed (`dollar_impact`, in dollars):

| bleed (USD) | severity   |
|-------------|------------|
| `>= 500`    | `critical` |
| `>= 200`    | `high`     |
| `>= 50`     | `medium`   |
| `> 0`       | `low`      |

A floor `MIN_BLEED_CENTS` (default `2000` = $20) suppresses noise clusters: below the
floor, no alert even if confidence clears the bar. (The `> 0 → low` row only applies at
or above the floor.)

### Alert row contract (per fired cluster)

Upsert into `alerts` keyed on `(shop_id, detector_id, entity_ref)` via the existing
partial unique index `alerts_active_condition_key` (migration
`20260614000000_alerts_condition_dedup.sql`). One row per standing condition; a
re-detect refreshes impact/severity/narrative/day_bucket/last_seen_at on the same row.

```
detector_id    = "free_shipping_leakage"
entity_ref     = { kind: "sku",  id: <sku_id>, sku: <human sku code>, zone?: null }
              or { kind: "zone", id: <zone band>, zone: <zone band> }
severity       = <by magnitude table>
dollar_impact  = <bleed in DOLLARS>   // NOTE: alerts.dollar_impact is dollars;
                                      // rowToAlert() *100 → cents at the read boundary
day_bucket     = <detection day, yyyy-mm-dd UTC>
status         = "open"   (on insert; upsert leaves an existing non-terminal row's status)
claude_narrative = <plain-language: "Free shipping on <SKU/zone> cost you $X more to
                    ship than customers paid, across N orders.">
claude_rank    = <by dollar_impact desc among this shop's open alerts; engine convention>
evidence (jsonb) = {
  cluster_kind: "sku" | "zone",
  sku?: <human sku code>,          // sku clusters; drives alerts.sku display
  zone?: <zone band>,
  free_ship_orders: <count>,
  shipping_collected_usd: <Σ shipping, USD string>,
  ship_cost_usd:          <Σ ship cost, USD string>,
  net_shipping_pnl_usd:   <net, USD string, negative>,
  ship_cost_confidence:   "high" | "med" | "low",   // dominant tier, for provenance tag
  current_free_ship_threshold_usd: <FREE_SHIP_THRESHOLD_CENTS/100>,
}
```

Evidence keys follow the existing labeler conventions (`_usd` → money, `_orders`
fallback to count) so both surfaces render them with no per-detector code. New
human-readable labels are registered in `EVIDENCE_LABELS` (see plan).

### Where it runs

The detector is invoked by the **detect cron path** alongside the other detectors.
`app/routes/cron.detect.tsx` delegates per-shop to `POST /api/engine/run`. Part 3 adds
the TS detector as a function `detectFreeShipLeakage(sb, shopId)` and wires its
invocation into the same per-shop detect pass (the engine-run route / detector
registry — exact wiring task in the plan). It reads `order_fact` (ship cost + shipping
+ zone fields), `order_line_fact` (grams/qty for the split), `sku_dim` (human code),
and upserts `alerts`. Idempotent per the condition key.

## propose_action wiring

Two new `ActionKind`s, both reversible:

- **`raise_free_ship_threshold`** — raise the order-value threshold above which
  shipping becomes free, so the bleeding zone/SKU stops qualifying for free shipping
  below cost. Payload (re-derived from the alert, never the request body):

  ```
  { kind: "raise_free_ship_threshold",
    params: {
      target: <sku code | zone band>,          // from alert.sku / entity_ref
      estimate_cents: <alert.dollar_impact>,    // recovered-impact estimate
      cluster_kind: "sku" | "zone",
      // suggested new threshold = current_free_ship_threshold + a buffer over the
      // per-order ship cost so the bleeding orders no longer ship free. The concrete
      // value is computed in the executor from the evidence, not the model.
      suggested_threshold_cents: <computed>,
      prev_threshold_cents: <current, for undo>,
    } }
  ```

- **`exclude_sku_free_ship`** — exclude the specific heavy SKU from the free-ship
  promotion (it still sells, but free shipping no longer applies to it). Payload:

  ```
  { kind: "exclude_sku_free_ship",
    params: {
      target: <sku code>,
      estimate_cents: <alert.dollar_impact>,
      sku_id: <sku_dim uuid>,                   // internal; suppressed from evidence UI
      sku: <human sku code>,
      excluded: true,                           // post-state; undo flips to false
    } }
  ```

Both are **non-platform** action kinds (no Meta/Google/Shopify mutation in v1 — they
record the merchant's policy decision + estimate and are reversible by recording the
inverse). They therefore use the **legacy execute path** (`client.actions.execute`)
that records an `action_audit` row, and **undo** via the legacy manual-insert path in
`calderyn.server.ts` `audit.undo` (they are NOT in `GATEWAY_UNDO_KINDS`), which writes
the inverse audit row and re-opens the alert. This matches `create_po_draft`'s
treatment exactly.

Allowed actions for the detector:

```
DETECTOR_TO_ACTIONS["free_shipping_leakage"] =
  ["raise_free_ship_threshold", "exclude_sku_free_ship", "snooze_alert"]
```

`exclude_sku_free_ship` is only meaningful for SKU clusters; the executor 403s it for a
zone cluster (no `sku_id` in evidence), mirroring how `reallocate_inventory` 422s when
its evidence is incomplete. `raise_free_ship_threshold` applies to both.

`propose_action` (MCP + dashboard chat) gains both kinds in its `action_kind` enum, and
the dashboard alert-action route gains them in its allowed-kinds set.

## Surfaces

### Embedded admin (Polaris) — point 4, kept minimal

The alert renders through the existing generic alert detail (`app/routes/
app.alerts.$id.tsx`) and list (`app/routes/app.alerts._index.tsx`), which are entirely
data-driven by `detector_id` + `DETECTOR_TO_ACTIONS` + evidence labels. No bespoke
Polaris component. The only admin-side work is registering the detector + actions in
the shared label/registry maps (`app/lib/labels.ts`, `app/lib/types.ts`) and the
evidence labels — which both surfaces share. Uses `@shopify/polaris-icons` where icons
appear (no Lucide in `app/routes/app.*`).

### Dashboard (non-Polaris) — parity, same task

Re-implement behavior against the dashboard's own primitives + Lucide/`CDIcon`. Three
pieces:

1. **Net-shipping-P&L column with provenance** in `app/components/dashboard/screens/
   Analytics.tsx`. A new per-SKU "Shipping P&L" section/list driven by a new analytics
   slice: per SKU, `shipping_collected − ship_cost` with a provenance tag
   (Actual / Reconciled / Modeled / Fallback) from the dominant `ship_cost_source`.
   New view-model `ShipPnlRow`, new client fetcher field, new `calderynClient.analytics`
   method reading `sku_pnl` (`ship_cost_cents`) + a shipping-collected aggregate. A new
   `CDIcon` entry (one line, Lucide `Truck`) for the section header.
2. **The leakage alert** renders automatically in `app/components/dashboard/screens/
   Alerts.tsx` (data-driven by `detector_id`), once `DETECTOR_TERMS` and
   `DETECTOR_TO_ACTIONS` carry `free_shipping_leakage` and `adaptAlert` emits the two
   new actions when present. The two new action buttons surface via `ACTION_LABELS` +
   `CD_ACTION_ICON` (one Lucide icon each, e.g. `Truck` / `Ban`).
3. **The provenance tag visible** — both in the new Analytics Shipping-P&L rows and as
   an evidence cell on the alert detail (`ship_cost_confidence` already in evidence;
   register a friendly `EVIDENCE_LABELS` entry). A small `ProvenanceTag` helper in the
   dashboard `ui.tsx` maps source → label + tone.

Dashboard parity is part of THIS task, not a follow-up.

## Out of scope / deferred (named)

- The three other alerts from the master design: **threshold mispricing**,
  **ship-cost variance** (Tier-1 vs model divergence), **adjustment drift**. Deferred
  to phase 2 (design "Alert" section).
- Real platform mutation for the two actions (Shopify free-shipping shipping-profile /
  discount API writes). v1 records the merchant's decision + estimate reversibly; the
  Shopify-side enforcement is a phase-2 growth upgrade. Flagged as a TODO in the
  executor.
- Multi-package split-shipment per-label modeling (inherited Plan 1 limitation).
- Merchant-tunable free-ship threshold / bleed floor in Settings UI (constants in v1;
  Settings exposure is phase 2, alongside Plan 2's Settings work).

## Testing strategy

- **Pure core (`detect-free-ship-leakage.ts`):** free-ship filter; SKU vs zone
  clustering; per-line split feeding SKU clusters; bleed = `max(0,−net)`; confidence
  gate (dollar-weighted majority; skip below the bar; the "one big fuzzy order can't
  sink an anchored cluster" case); severity table; `MIN_BLEED_CENTS` floor; positive-net
  cluster never fires.
- **I/O wrapper (`detect-free-ship-leakage.server.ts`):** fake Supabase client
  (the `SeedWriterClient` / Plan-1-runner pattern) — reads order/line/sku rows, calls
  the core, upserts with `onConflict: "shop_id,detector_id,entity_ref"`, writes the
  exact alert row contract; no fire → no upsert; idempotent re-run updates not inserts.
- **Labels/registry:** `free_shipping_leakage` present in every `Record<DetectorId,…>`
  map (exhaustiveness keeps `tsc` honest); the two actions present in every
  `Record<ActionKind,…>` map and the `propose_action` enum.
- **propose_action:** allows the two new kinds for `free_shipping_leakage`; rejects
  them for other detectors; rejects `exclude_sku_free_ship` for a zone cluster.
- **Action executor + undo:** records the audit row with the re-derived payload;
  guardrail dollar-cap check applies; undo writes the inverse and re-opens the alert.
- **Dashboard:** `adaptAlert` emits the two ship actions for the new detector;
  analytics slice maps `sku_pnl` → `ShipPnlRow` with the right provenance tag; the
  new alert-action route allows the two kinds.
