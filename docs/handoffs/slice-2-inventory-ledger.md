# Slice 2 — Smart Inventory Ledger: build handoff

**Branch:** `feat/inventory-ledger` (off `origin/main`). **Status:** Plan A (engine) built, reviewed, **applied to prod + verified**; Plan B (merchant tools) built + gated, with two documented seams (below). Not yet merged or pushed.

## What shipped

**Plan A — stock engine** (`app/lib/inventory/*`, `supabase/migrations/202606291600*`):
- Owned `inventory_balance` / `inventory_ledger` / `inventory_reservation` / `inventory_transfer` tables; `location_dim` gained `priority` / `lat` / `lng` and `external_id` made nullable.
- Atomic, shop-scoped Postgres functions (all `search_path=''`): `inventory_reserve` / `inventory_commit` / `inventory_release` (the buyer path) and `inventory_adjust` / `inventory_mark_unavailable` / `inventory_create_transfer` / `inventory_receive_transfer` (merchant path). Every balance mutation is a `FOR UPDATE` lock + relative/conditional write — never read-then-write — and journals a ledger row in the same transaction.
- Pure TS allocator (`allocate.ts`): nearest-to-buyer by haversine when coords exist, else priority order.
- `engine.server.ts`: thin RPC wrappers + `getVariantBalances` / `setReorderPoint` reads; projects `on_hand - unavailable` (sellable) into `inventory_level_fact` after every on_hand/unavailable change so the existing engine reads owned numbers.
- Reaper cron `/cron/inventory-reaper` (`*/5 * * * *`, in `vercel.json`) releases expired holds.

**Plan B — merchant tools** (`app/routes/dashboard.api.catalog.*`, `app/components/dashboard/screens/*`, `client.ts`):
- API: `inventory.$variantId` (GET balances; PUT set_on_hand / set_reorder / mark_unavailable), `inventory.transfer` (POST create / receive), `inventory.$variantId.history`, `locations._index` (GET), `locations.$id` (PUT priority/coords). All `requireDashboardSession`-gated, writes `requireSameOrigin`-gated, scoped by `session.shopId`; engine business errors mapped to 422.
- UI: `Locations` settings screen (nav-registered: rank + coordinates), `InventoryPanel` (per-location on-hand/reorder edit, mark damaged, an "In transit" list that receives pending transfers, history), `TransferModal` (move stock instant / in-transit). Browser client functions in `client.ts`. The full transfer lifecycle (create instant/in-transit → receive) has a UI path; no creatable-but-unreceivable dead-end.

## Prod state (Supabase `ajgrmnvzxfxxlwrxcgnu`)
- 4 migrations applied (tables → reserve_fn → merchant_fns → seed) + the `search_path=''` pins.
- Seeded **639** `inventory_balance` rows from the latest `inventory_level_fact` per (variant, location); 2 shops got a `Primary` location; negative observations clamped to 0.
- Verified: full reserve→replay→commit→double-commit lifecycle, multi-variant cart, clamp, transfers/receive all correct on real Postgres; **true two-session concurrency proven** (one wins, one `insufficient_stock`). Advisors: the new tables show `rls_enabled_no_policy` (INFO — the repo's intended service-role-only pattern, same as every table); the 7 functions' `search_path` WARN is cleared.

## Seam 1 — wire `InventoryPanel` into the product editor (waits on Slice 1 Plan B2)
`InventoryPanel.tsx` + `TransferModal.tsx` are built and gated but **not yet mounted** — Slice 1 Plan B2's `ProductEditor.tsx` does not exist on this base. The `Locations` screen IS mounted. When `ProductEditor.tsx` ships, drop the panel into its Variants section, only for a saved product/variant:

```tsx
import InventoryPanel from "./InventoryPanel";
// ...in the Variants section, when editing an existing product (id set) and the variant has an id:
{id && variants.some((v) => v.id) && (
  <section className="cd-card cd-pad">
    <h2 className="cd-h2">Stock by location</h2>
    {variants.filter((v) => v.id).map((v) => (
      <div key={v.id} style={{ marginBottom: 16 }}>
        <div className="cd-caption">{(v.optionValues ?? []).join(" / ") || "Default"}</div>
        <InventoryPanel app={app} variantId={v.id!} />
      </div>
    ))}
  </section>
)}
```
Also: Slice 1 B2's variant grid has a single "stock count" field writing `variant_dim.inventory_on_hand`. Once the panel is mounted, `inventory_balance` is the authority — make that field read-only (or remove it); `inventory_on_hand` stays only as the seed for a brand-new variant before its first balance row.

## Seam 2 — engine test-schema mirror + concurrency test (waits on Slice 1 catalog migration)
The SQL migrations live in `supabase/migrations/` only. The plan's "also copy into `tests/engine/schema/migrations/`" was **deferred**: on a `main` base the engine test schema has no `variant_dim` (it's a Slice-1 owned table), so adding an FK to it there would break `test-db.sh up` for everyone. When Slice 1's catalog migration lands in the test schema, copy the three inventory migrations across.
- The concurrency test (`app/lib/inventory/__tests__/reserve-concurrency.test.ts`) is `describe.skip` without `TEST_DATABASE_URL` and uses a typed dynamic `pg` import (no `pg` dependency added). To run it: `npm i -D pg`, point `TEST_DATABASE_URL` at a Postgres with the inventory tables + functions, then `npx vitest run`.

## Engine-side follow-ups (not this slice)
- `v_skus_flat` / `v_skus_flat_ship_pnl` / `v_skus_flat_ship_cost` order their latest-observation CTE by `observed_at desc` only. The projection now upserts on `(sku_id, location_id, source_version)` so a same-ms re-projection can't throw, but for a fully deterministic newest-wins read those views should add `source_version desc` to the tie-break (matching `v_sku_regional_demand`). Engine territory.
- Autopilot → primitives wiring (graduated `createTransfer` / reorder proposals when `available < reorder_point`) is a thin follow-on; the spec scoped it out — this slice exposes the primitives + reorder column + signal.

## Slice 3 contract (Eric's checkout)
`reserveStock(shopId, variantId, qty, checkoutRef, dest?)` → `{ ok: true, allocation: [{ locationId, qty, backorder? }] } | { ok: false, reason: "insufficient_stock" }`, one call per line item (shared `checkoutRef`). At payment: `commitReservation(shopId, checkoutRef)`. On abandon/expiry: `releaseReservation(shopId, checkoutRef)` (the reaper also calls it). All idempotent on `checkoutRef`; backorder is wired in SQL but disabled in TS (`p_allow_backorder=false`).

## Dashboard parity
Plan B *is* the dashboard — this repo's `dashboard.*` routes are the deployed dashboard, so parity is satisfied in-repo (no separate mirror). Like Slices 0 and 1, this owned-platform surface is dashboard-only; it is intentionally NOT mirrored into the embedded Shopify admin (`app.*`).
