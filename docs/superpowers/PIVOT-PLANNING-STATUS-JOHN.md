# Pivot Planning Status — John's half (specs + plans)

**Date:** 2026-06-29
**What this is:** the design specs + implementation plans for the **engine-room half** of the platform pivot (John's track). Everything here is **planned, not built** — these are the docs to review/agree before any code lands. Eric: this is where my side is at and what your side will plug into.

**Direction:** [Calderyn Platform Pivot — Build Map](./specs/2026-06-27-calderyn-platform-pivot-design.md) (already on `main`, PR #208). Calderyn becomes a direct Shopify competitor; we own catalog/inventory/checkout/payments and keep the autopilot + ad brain on top.

---

## Work split (from the build map)

| **John — engine room** | **Eric — storefront** |
|---|---|
| Login / tenant identity | Storefront pages |
| Owned catalog | Cart / checkout / orders |
| Inventory ledger | **Stripe payments** |
| Store-action executor (autopilot's hands) | Buyer accounts / identity |
| Import from Shopify (data port) | **Shipping quote engine** + carrier adapter |
| Ingest spine + go-live cutover | Buy-in-chat, ads experimentation |

---

## What I've fully planned (review these)

| Piece | Spec | Plan(s) | Build-ready? |
|---|---|---|---|
| **Slice 0 — first-party login** | [spec](./specs/2026-06-28-slice-0-first-party-auth-design.md) | [Plan 1: foundation + Door B](./plans/2026-06-28-slice-0-first-party-auth.md) | ✅ yes (build first — everything hangs off it). Plan 2 (Shopify-connect bridge) parked. |
| **Slice 1 — owned catalog** | [spec](./specs/2026-06-28-slice-1-owned-catalog-design.md) | [A: data](./plans/2026-06-28-slice-1-owned-catalog-plan-a-foundation.md) · [B1: API](./plans/2026-06-28-slice-1-owned-catalog-plan-b1-api.md) · [B2: editor UI](./plans/2026-06-28-slice-1-owned-catalog-plan-b2-ui.md) | ✅ yes |
| **Slice 2 — inventory ledger** | [spec](./specs/2026-06-28-slice-2-inventory-ledger-design.md) | [A: engine](./plans/2026-06-29-slice-2-inventory-plan-a-engine.md) · [B: merchant tools](./plans/2026-06-29-slice-2-inventory-plan-b-ui.md) | ✅ yes |
| **Store-action executor** | [spec](./specs/2026-06-29-slice-store-action-executor-design.md) | [plan](./plans/2026-06-29-store-action-executor-plan.md) | ✅ yes (after Slices 1–2) |
| **Import from Shopify (data port)** | [spec](./specs/2026-06-29-import-from-shopify-promote-design.md) | [plan](./plans/2026-06-29-import-from-shopify-promote-plan.md) | ✅ yes (after Slices 1–2) |

**Build order:** Slice 0 → Slice 1 → Slice 2 → store-action executor / import (either order). All in isolated worktrees off `origin/main`.

## Still to plan on my side (blocked on Eric)

- **Ingest spine** — catches your checkout's "order paid" event → records the sale into the warehouse (keeps ROAS/grades/autopilot fed once a merchant is on our own checkout) + deterministic ad-attribution. **Needs your checkout to emit events first.**
- **Cutover go-live flip** — flips a merchant from mirroring Shopify to live on Calderyn (with a test-sale gate). **Needs your checkout.**

---

## The hand-off contracts (what your side plugs into)

These are the seams between our halves — let's agree the shapes:

1. **Catalog read** (John → Eric): your storefront/checkout reads owned products/prices/status. Shape defined in Slice 1 B1 (`catalog.server.ts` + `dashboard.api.catalog.*`).
2. **Stock reserve/commit/release** (John → Eric): your checkout calls these — `reserveStock(shopId, variantId, qty, checkoutRef, dest?)` → `commitReservation(checkoutRef)` at payment → `releaseReservation` on abandon. Built + concurrency-tested in Slice 2 Plan A (`inventory/engine.server.ts`). **This is the main thing your checkout calls into my side.**
3. **Owned-event schema** (Eric ↔ John): your checkout emits `CHECKOUT_COMPLETED` (+ what's in it) → my ingest spine consumes it. **Not designed yet — let's define this together when your checkout takes shape.**
4. **Shipping quote** (Eric → John): your quote engine's `getRates(...)` — the autopilot/checkout consume it. Your side.

---

## Status

**Nothing is built or merged yet** — these are plans for review. My half is fully mapped; the last two pieces (ingest spine, go-live) wait for your checkout so we can agree the event contract. Reviews/changes welcome before we start coding.
