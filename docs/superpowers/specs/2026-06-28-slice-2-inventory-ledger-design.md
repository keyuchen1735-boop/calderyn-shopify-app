# Slice 2 — Smart Inventory (Multi-Location Ledger)

**Date:** 2026-06-28 (updated 2026-06-29: nearest-to-buyer + Shopify-parity states folded in)
**Status:** Design approved (brainstorm). Ready for spec review → implementation plan.
**Parent:** [Calderyn Platform Pivot — Build Map](./2026-06-27-calderyn-platform-pivot-design.md), feature `#4`. Depends on Slice 1 (owned `variant_dim`). Its reserve/commit primitives are consumed by Slice 3 (checkout), which is NOT built here.

**Benchmark:** Shopify is the parity target for inventory features (Stripe handles money, not stock). Goal is Shopify-parity **and better** — the "better" is the owned ledger feeding Calderyn's existing autopilot so stock is *acted on*, not just tracked.

---

## Goal

A real, owned, transactional stock system that **cannot oversell** — per-location balances with atomic reservations and decrement, address-aware fulfillment, and Shopify-style stock states — plus the merchant tools to manage it. Today inventory is a read-only append-only mirror of Shopify observations (`inventory_level_fact`); there is no decrementable quantity anywhere. The "decrement on a real sale" wiring lives in Slice 3; this slice builds and tests the primitives checkout will call.

Slice 2 is **done** when stock is tracked per (variant, location) with Shopify-style states, cannot be oversold (proven by a concurrent two-buyer test), the allocator fills nearest-to-buyer (falling back to priority order), the merchant can adjust counts and move stock (including in-transit transfers) with a recorded history, and the existing engine's stock reports keep working.

---

## Decisions (locked in brainstorm)

| Decision | Choice |
|---|---|
| Locations | **Multi-location** — stock tracked per (variant, location) |
| Allocator | **Destination-aware** — given a buyer address it fills from the nearest location(s) by distance; with no address it falls back to the merchant's **priority ranking**. Splits down the chosen order; rejects if uncoverable (unless backorder policy). Both paths built now; the nearest path activates once Slice 3 passes addresses |
| Stock states | **Shopify-parity** — `on_hand`, `reserved`, `incoming` (on the way), `unavailable` (damaged/safety stock); `available = on_hand − reserved − unavailable` |
| Reorder points | **Yes** — per (variant, location) low-stock threshold feeding the engine's stockout alerts + the autopilot |
| Transfers | **Instant or in-transit** — a transfer can land immediately or be marked in-transit (shows as `incoming` at the destination until received) |
| Merchant stock tools | **Simple** — edit the count per location + move stock; history recorded automatically (no required movement labels) |
| Checkout wiring | **Out of scope** — reserve/commit/release built + unit-tested here; Slice 3's checkout calls them |
| Opening balance | **Seed from `inventory_level_fact`** — the authoritative per-location stock from the mirror/backfill (latest observation per variant+location). `variant_dim.inventory_on_hand` is 0 on promoted rows, so it's only the fallback for fresh-typed products with no observation. |

---

## Data model (owned tables)

- **`inventory_balance`** — the mutable, decrementable state. `id`, `shop_id`, `variant_id → variant_dim`, `location_id → location_dim`, `on_hand int`, `reserved int`, `incoming int default 0`, `unavailable int default 0`, `available int generated always as (on_hand - reserved - unavailable) stored`, `reorder_point int null`, `version bigint`, `updated_at`; `unique(variant_id, location_id)`.
- **`inventory_ledger`** — append-only journal of every movement. `id bigserial`, `shop_id`, `variant_id`, `location_id`, `entry_type text check (receive|adjust|transfer_out|transfer_in|in_transit|received|reserve|release|sale|mark_unavailable)`, `qty int` (signed), `reservation_id null`, `transfer_id null`, `order_ref text null`, `idempotency_key text`, `reason text null`, `source text`, `created_at`; `unique(shop_id, idempotency_key)`.
- **`inventory_reservation`** — time-boxed holds. `id uuid`, `shop_id`, `variant_id`, `location_id`, `qty int`, `state text check (held|committed|released|expired)`, `checkout_ref text`, `expires_at timestamptz`, `idempotency_key`, `created_at`. One buyer order produces one reservation row per location the allocator used.
- **`inventory_transfer`** — a move between locations. `id uuid`, `shop_id`, `variant_id`, `from_location_id`, `to_location_id`, `qty int`, `state text check (in_transit|received|cancelled)`, `created_at`, `received_at`. Instant transfers skip straight to `received`.
- **`location_dim`** — ADD `priority int not null default 0` (lower = filled first), `lat double precision null`, `lng double precision null` (for nearest-to-buyer distance). Keep `inventory_level_fact` as-is (the Shopify-observed shadow, now also the engine-compat projection target — see below).

---

## The engine (primitives — built + tested here, called by Slice 3)

All live in `app/lib/inventory/*.server.ts`, keyed by `shop_id`, each writing an `inventory_ledger` entry:

- `reserveStock(shopId, variantId, qty, checkoutRef, destination?): Promise<{ ok: true; allocation: Array<{ locationId; qty }> } | { ok: false; reason: "insufficient_stock" }>` — orders candidate locations by the allocator (nearest-to-`destination` when coords are present, else by `priority`); for each, runs the **atomic conditional hold** `update inventory_balance set reserved = reserved + n, version = version + 1 where variant_id = … and location_id = … and (on_hand - reserved - unavailable) >= n returning *` (zero rows ⇒ that location can't cover ⇒ next). Honors `variant_dim.inventory_policy` (`deny` rejects when total available < qty; `continue` permits a backorder hold at the primary location). Records `reserve` ledger rows + `inventory_reservation` rows.
- `commitReservation(checkoutRef)` — at payment: per held row, `on_hand -= qty, reserved -= qty`, state → `committed`, write a `sale` ledger entry. Idempotent on `checkoutRef`.
- `releaseReservation(checkoutRef)` — on abandon/expiry: `reserved -= qty`, state → `released`. Idempotent.
- `adjustStock(shopId, variantId, locationId, newOnHand, reason?)` — merchant sets a count; writes an `adjust` ledger entry for the delta.
- `markUnavailable(shopId, variantId, locationId, qty, reason)` — moves qty from available into the `unavailable` bucket (damaged / safety stock).
- `createTransfer(shopId, variantId, fromLocationId, toLocationId, qty, mode: "instant" | "in_transit")` — instant: `from.on_hand -= qty`, `to.on_hand += qty` (`transfer_out`/`transfer_in`). in-transit: `from.on_hand -= qty`, `to.incoming += qty`, transfer row `in_transit` (`transfer_out`/`in_transit`). Rejects if source `available < qty`.
- `receiveTransfer(transferId)` — `to.incoming -= qty`, `to.on_hand += qty`, transfer → `received` (`received` ledger entry). Idempotent.
- **Allocator** (`app/lib/inventory/allocate.ts`, pure): `orderLocations(locations, destination?)` → nearest-first by haversine when both have coords; else by `priority`; ties broken by `priority`. Unit-tested independently of the DB.
- **Reaper** (`cron.inventory-reaper`): expires `held` reservations past `expires_at` back to `available` (via `releaseReservation`). Existing Vercel cron pattern, guarded by `CRON_SECRET`.

**Atomic correctness is the whole game.** The hold/decrement MUST be a single conditional `UPDATE … WHERE (on_hand - reserved - unavailable) >= n RETURNING` (or `SELECT … FOR UPDATE` in a transaction), never read-then-write. This is the warehouse's first mutable concurrent write path; a non-atomic version oversells under load.

---

## Engine compatibility (keep the brain alive)

The engine's stock detectors (`stockout_forecast`, days-of-cover, `v_sku_inventory_history`) read `inventory_level_fact`. Same pattern as Slice 1's `sku_dim` projection: **after any owned balance change, write an `inventory_level_fact` observation row** for that (variant→`sku_dim.id`, location) with the new `on_hand` as `available`. The engine reads the latest observation = the owned balance, unchanged. `inventory_level_fact` stays a table; the owned balance is the new authority, projected into it.

---

## Better than Shopify — the autopilot edge

Shopify *shows* you a stock problem; Calderyn can *fix* it. The autopilot already ships `reallocate_inventory` and stockout forecasting against the read-only mirror. Once this owned ledger exists, those become real: the autopilot can call `createTransfer` to rebalance stock toward demand, and surface reorder proposals when `available` drops below `reorder_point`. No new brain is needed — the existing detector→rank→(graduated) action loop just gains real inventory primitives to act on. (The autopilot *wiring* to these primitives is a thin follow-on; this slice exposes the primitives + reorder signal.)

---

## Merchant UI (dashboard)

Extends the catalog surface from Slice 1 (`cd-*`, `dashboard.api.*`):

- **Per-location stock** in the product editor's variant grid: each variant shows on-hand / reserved / incoming / available per location; the merchant edits on-hand per location (→ `adjustStock`) and can mark units unavailable.
- **Reorder point** per (variant, location).
- **Move stock**: a transfer action (variant, from, to, qty, instant or in-transit → `createTransfer`); in-transit transfers are receivable (→ `receiveTransfer`).
- **History**: a per-variant view of recent `inventory_ledger` entries.
- **Location settings**: rank locations (`priority`) and set each location's map coordinates (`lat`/`lng`) for nearest-to-buyer.

---

## Out of scope (deferred)

- The checkout that calls reserve/commit (Slice 3).
- Purchase orders / structured receiving workflows (just adjust + transfer for v1).
- Backorder/pre-order merchant UX beyond honoring the existing `inventory_policy` flag.
- Cost-layer accounting (FIFO/LIFO), multi-currency stock valuation.
- Automatic geocoding of a location's address into `lat`/`lng` (merchant enters coordinates or picks on a map; auto-geocode is a later nicety).
- The autopilot-to-primitives wiring itself (this slice exposes the primitives + reorder signal; the graduated action wiring is a follow-on).

---

## Success criteria

1. Stock is tracked per (variant, location) with correct on_hand / reserved / incoming / unavailable / available.
2. `reserveStock` atomically holds across locations and **rejects when it can't cover** — proven by a concurrency test: two simultaneous reserves for the last unit, exactly one succeeds.
3. The allocator orders locations nearest-to-buyer when a destination is supplied, and by priority otherwise (pure unit test).
4. `commitReservation` / `releaseReservation` are correct and idempotent; the reaper expires stale holds.
5. `createTransfer` (instant + in-transit) and `receiveTransfer` move stock correctly; `markUnavailable` shifts available → unavailable.
6. The merchant can edit per-location counts, set reorder points, and transfer stock; every change lands in `inventory_ledger`.
7. The engine's stock reports still work (via the `inventory_level_fact` projection).
8. `inventory_balance` is seeded from `inventory_level_fact` (real per-location stock), with `inventory_on_hand` as the fallback only for fresh-typed products that have no observation — a migrated store shows its true stock, not zeros.

---

## Risks

- **Concurrency correctness** — the conditional decrement must be a real row-locked / conditional `UPDATE`. New failure mode for a warehouse that has never done mutable concurrent writes; a bug oversells real orders.
- **No Postgres RLS** — a mutable cross-tenant inventory authority raises the blast radius of any missed `shop_id` filter (hardened later in `#12`).
- **Nearest-to-buyer needs coordinates** — without `lat`/`lng` on a location it silently falls back to priority order; the merchant must set coordinates for nearest to work (surfaced in the UI, not silent).
- **Primitives unexercised until Slice 3** — reserve/commit are built + unit-tested here but no real checkout calls them until Slice 3; the concurrency unit test is the v1 proof.
- **Projection drift** — every owned balance change must project to `inventory_level_fact`, or the engine reads stale stock (same discipline as Slice 1).

---

## Next step

User reviews this spec → `writing-plans`. Likely split: **Plan A** (tables + engine primitives + allocator + projection + seed), **Plan B** (merchant UI: per-location stock, transfers, reorder points, location settings). Build in an isolated worktree (`feat/inventory-ledger`) off `origin/main`.
