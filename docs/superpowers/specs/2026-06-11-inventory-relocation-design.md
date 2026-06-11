# Inventory Relocation on the Inventory Page — Design

**Date:** 2026-06-11
**Status:** Approved (brainstorming session)
**Surfaces:** Shopify extension (`app.skus.tsx`) + Calderyn dashboard (parity mandatory)

## Goal

Let merchants see, per product, where demand actually is ("main demand
region") and move stock there directly from the Inventory page — without
waiting for a detector alert. Transfers reuse the existing
`reallocate_inventory` execution path (Shopify `inventoryAdjustQuantities`,
guardrails, audit log, undo).

## Decisions made

| Question | Decision |
|---|---|
| Demand signal | **Sales-based**: 30-day order volume per SKU per region, attributed via successful fulfillments (`order_line_fact` → `fulfillment_fact` → `location_dim.region`) — same SQL shape as the `regional_shortage_risk` detector. |
| Relocation UX | **Prefilled, editable**: rows with a demand/stock mismatch get a Relocate action opening a modal prefilled with the suggested plan; merchant can edit source, destination, quantity. |
| Audit/undo | **Full parity** with alert-driven transfers: guardrail check, audit entry with pre/post state, undo-eligible. `alert_id` is `null` for page-initiated transfers (field already nullable). |
| Parity scope | **Both surfaces** in this task. |
| Architecture | **Approach A — SQL view**: demand + transfer candidates computed in a Supabase view; suggestion policy derived in the shared TypeScript client; both surfaces consume the shared SKU DTO. |

## Architecture

```
Supabase Postgres
  v_sku_regional_demand (NEW VIEW, one row per shop_id+sku_id)
        │
calderyn.server.ts  skus.list()  (+ locations.list())
    SKU DTO + { demand, suggested_transfer }
        │                          │
app.skus.tsx (Polaris)      dashboard.api.skus → dashboard SKUs view
  demand column + Relocate modal     demand column + relocate dialog
        │                          │
  route action              dashboard.api.skus.relocate (NEW)
        └──────────┬───────────────┘
        app/lib/actions/relocate.server.ts  executeRelocation()  (NEW, extracted)
          guardrails → inventoryAdjustQuantities → audit entry (undo-eligible)
```

## 1. Data layer

### Migration: `v_sku_regional_demand`

One row per `(shop_id, sku_id)` for SKUs with 30-day sales:

- `main_demand_region` — region with highest 30-day demand;
  demand = `sum(order_line_fact.quantity)` joined to
  `fulfillment_fact (status = 'success')` → `location_dim.region`.
  Tie-break: demand desc, region asc (deterministic).
- `demand_units_30d`, `demand_share` (fraction of the SKU's total 30-day
  demand in that region).
- `stock_in_region` — current available stock in the demand region.
- `dest_location_external_id`, `dest_location_name` — deterministic active
  location inside the demand region (same LATERAL pick as
  `regional_spend_starved_stock`).
- `src_location_external_id`, `src_location_name`, `src_available` —
  largest available holder of the SKU **outside** the demand region.
- `inventory_item_id` from `sku_dim`.

### Shared client (`app/lib/calderyn.server.ts`)

- `skus.list()` adds one PostgREST query against the view (explicit row cap,
  per the existing 1000-row-cap convention) and merges into the SKU DTO.
- Suggestion policy lives in TypeScript (presentation policy, not data):
  a **mismatch** exists when `stock_in_region < 7 days × regional daily
  demand` and stock exists elsewhere. `recommended_delta =
  min(7d regional demand − stock_in_region, src_available)`, floored to a
  positive integer.
- New `locations.list()` → `{ external_id, name, region, active }[]` for the
  modal's location selects.

### DTO extension (`app/lib/types.ts`, `SKU`)

```ts
demand: {
  region: string;
  units_30d: number;
  share: number;          // 0..1
  stock_in_region: number;
} | null;                  // null when no 30-day sales
suggested_transfer: {
  inventory_item_id: string;
  from_location_id: string;  from_location_name: string;
  to_location_id: string;    to_location_name: string;
  recommended_delta: number;
} | null;                  // null when no mismatch or no viable source/dest
```

## 2. Shared executor

Extract the reallocate branch currently inline in `app.alerts.$id.tsx` into
`app/lib/actions/relocate.server.ts`:

```ts
executeRelocation({ shop, plan, idempotencyKey, actor, alertId: string | null })
```

Responsibilities: validate plan shape, guardrail check (daily action
budget), run `inventoryAdjustQuantities`, surface `userErrors`, record the
audit entry (`action_kind: "reallocate_inventory"`, pre/post state with
reverse delta, undo-eligible, `alert_id` null when page-initiated). The
alert route and both new entry points call this single path — no logic fork.

## 3. UI

### Extension (`app/routes/app.skus.tsx`)

- New **"Main demand"** column between Locations and Alerts: region +
  `units/30d`; warning tone when `stock_in_region === 0`; "—" for SKUs with
  no sales (consistent with days-of-cover treatment).
- Rows with `suggested_transfer` get a **Relocate** button → Polaris
  `Modal`, prefilled: source `Select` (locations holding the SKU),
  destination `Select` (active locations), quantity `TextField`
  (prefilled `recommended_delta`). Copy explains the why ("Main demand is
  {region}, which holds {n} units") and safety ("Recorded in the audit log.
  Reversible via Undo.").
- New route `action`: validate FormData at the boundary, call
  `executeRelocation`, return typed result; toast via `useActionToast`;
  stable idempotency key per modal-open (`useStableIdempotencyKey` pattern).

### Dashboard (mirror, not port)

- Demand fields flow automatically through `dashboard.api.skus` (shared DTO).
- New write route `dashboard.api.skus.relocate.tsx` following the
  `dashboard.api.alerts.$id.action` pattern (`requireDashboardSession`,
  validation, same `executeRelocation`).
- Dashboard SKUs view gets the demand column + relocate dialog using the
  dashboard's own primitives; `relocateSku` fetch wrapper beside the
  existing `executeAlertAction` client helper.

## 4. Error handling (fail visibly)

- Action-boundary validation → 422 with stable codes:
  `INVALID_TRANSFER_PLAN`, `SAME_LOCATION`, `QTY_EXCEEDS_AVAILABLE`.
- Shopify `userErrors` surfaced verbatim in the error toast and recorded as
  a **failed** audit entry.
- Guardrail breach blocks with the existing guardrail error shape.
- Source availability re-checked server-side at execution time — loader
  snapshots are not trusted; stale transfers fail with a clear message.
- Demand without a viable source/destination → demand column shown, no
  Relocate button (absence of action, never a dead button).
- Undo via the existing audit undo route (reverse delta in pre/post state).

## 5. Testing

- **Suggestion derivation (unit):** mismatch → plan with correct delta;
  no sales → `demand: null`; no source stock → `suggested_transfer: null`;
  deterministic tie-break.
- **Route actions:** `app.skus.tsx` action and `dashboard.api.skus.relocate`
  via the existing `api-write-routes.test.ts` harness: happy path (exact
  ids/delta passed to the mutation, audit recorded), each validation
  rejection, `userErrors` → failed audit entry, guardrail block.
- **View fixture test:** seed orders/fulfillments/locations in the
  disposable-Postgres engine test setup; assert top region and transfer
  candidates from `v_sku_regional_demand`.
- **Refactor proof:** existing alert-route tests stay green after the
  executor extraction.

## Out of scope (YAGNI)

- Multi-hop transfers (one source → one destination per action, matching
  the executor).
- Demand forecasting beyond the 30-day window.
- Per-location demand below region granularity (fulfillment attribution is
  regional).
- New detector work.
