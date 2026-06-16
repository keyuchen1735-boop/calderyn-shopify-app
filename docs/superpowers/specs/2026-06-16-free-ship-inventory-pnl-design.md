# Free-ship "Ship P&L" column under Inventory — design

**Date:** 2026-06-16
**Surfaces:** embedded Shopify admin (`app/routes/app.skus.tsx`, Polaris) + Calderyn dashboard (`app/components/dashboard/screens/Inventory.tsx`, `.cd-*`).
**Status:** approved (design), implementing test-first.

## Goal

Surface the true-ship-cost / free-shipping-leakage signal directly on the
Inventory screen as a per-SKU **Ship P&L** column, so a merchant sees which SKUs
make or lose money on shipping — not just an alert after the fact.

## Metric

Per SKU, over the same trailing 30-day window `v_skus_flat` already uses for
velocity:

```
ship_pnl_cents = Σ allocated shipping_cents (collected)
               − Σ allocated ship_cost_cents (true carrier cost)
```

Each order's `shipping_cents` and `ship_cost_cents` (from `order_fact`) are split
across that order's lines by quantity share, then summed per SKU.

- **Positive** → shipping pays for itself on that SKU.
- **Negative** → free shipping is bleeding money on that SKU (leakage).
- **`$0` / null** → no shipped orders for the SKU in-window.

## Data — approach A (view-only)

Extend `v_skus_flat` to compute `ship_pnl_cents` from the order → line → sku join
the view already performs (for worst-provenance + velocity). No new `sku_pnl`
column, no `runner.server.ts` or seed-writer change. One migration (the view).

Rationale: the metric is self-contained for the inventory surface; keeping it in
the view avoids resolver/seed churn. (Rejected alternative B: add
`sku_pnl.ship_collected_cents` written symmetrically by the runner — only needed
if the column must reconcile exactly with `sku_pnl`'s ship-cost allocation.)

Allocation basis: by line **quantity** share of the order, matching how the view
derives `units_per_day`. Free-ship orders have `shipping_cents = 0`, so they push
`ship_pnl_cents` negative — exactly the leakage signal.

## DTO (shared, both surfaces inherit it)

- `SKU` (`app/lib/calderyn.server.ts` types): add `ship_pnl_cents: number | null`.
- `rowToSku`: map `r.ship_pnl_cents` (null when the view omits it).
- `SkuVM` (`app/components/dashboard/view-models.ts`): add `ship_pnl_cents`.
- `adaptSku`: carry it through.

## UI — dashboard (Calderyn)

New "Ship P&L" column in `Inventory.tsx`'s `.cd-table`: `tabular-nums`, green for
`≥ 0`, red for `< 0`, subdued `$0`/`—` when null, with a `.cd-caption` tooltip
("Shipping collected − true ship cost, last 30d"). Placed next to the existing
`ShipCostPill`.

## UI — embedded (Polaris)

New "Ship P&L" `IndexTable` column in `app.skus.tsx`: right-aligned numeric
`<Text>` with `tone="success"` (`≥ 0`) / `tone="critical"` (`< 0`) / subdued
(`$0`/null). Placed next to `ShipCostBadge`. Heading added to `headings`
(non-sortable for v1).

## Shared formatting helper

`formatShipPnl(cents: number | null): { label: string; tone: "pos" | "neg" | "zero" }`
— single source of truth for sign/label/tone, used by both surfaces. `null`/`0`
→ `{ "$0", "zero" }` (embedded maps `pos→success`, `neg→critical`, `zero→subdued`;
dashboard maps to its tone classes).

## TDD plan (red → green per layer)

1. `formatShipPnl` helper — sign, `$`, thousands, `$0`/null, tone. (pure unit)
2. Seed/dataset — `ship_pnl_cents` derivable: a negative free-ship SKU and a
   positive paid-ship SKU in the seed produce expected signs.
3. `rowToSku` — maps `ship_pnl_cents`, null-safe.
4. `adaptSku` — `SkuVM.ship_pnl_cents` populated.
5. Dashboard `Inventory` — column renders value + tone for a fixture SKU.
6. Embedded `app.skus` — column renders value + tone for a fixture SKU.
7. Migration — `npx prisma migrate diff`/`supabase` validate; view returns the
   column (verified against seed where feasible).

## Out of scope (YAGNI)

No new sorting/filtering on the column, no summary banner, no zone-level rows
(zone leaks stay in the Alerts surface). Can follow later if wanted.

## Parity

Both surfaces consume `ship_pnl_cents` from the shared `calderynClient.skus.list()`
DTO and the shared `formatShipPnl` helper — contract-mirrored, not code-copied.
