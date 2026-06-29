# Store-Action Executor (Owned Writes)

**Date:** 2026-06-29
**Status:** Design approved (brainstorm). Ready for spec review → implementation plan.
**Parent:** [Calderyn Platform Pivot — Build Map](./2026-06-27-calderyn-platform-pivot-design.md), feature `extend:ActionAdapter` / `extend:write-back`. Depends on Slice 1 (owned catalog) + Slice 2 (inventory engine). John's track (the autopilot's "hands").

---

## Goal

Re-point Calderyn's existing store actions from Shopify writes to **owned-table** writes, so when the autopilot or a merchant runs a store action it changes Calderyn's own catalog/inventory — not Shopify. This is a **body-swap**, not a new system: the action kinds, the audit log, idempotency, undo, calibration, graduation, and the autopilot loop all already exist and stay unchanged. Only the line that *writes* changes target.

Done when the autopilot or a merchant can change a price, move stock, or discontinue a product, the change lands in the owned tables (Slice 1/2), it records an `action_audit` row, and it can be undone — with **no Shopify API calls**.

---

## Decisions (locked in brainstorm)

| Decision | Choice |
|---|---|
| Write target | **Owned tables only** — no Shopify writes anywhere in these executors |
| Scope | The three existing store action kinds: **`adjust_price`**, **`reallocate_inventory`**, **`discontinue_sku`** (+ their undo branches) |
| Shared machinery | **Unchanged** — `executeAction`'s audit tail (`insertAuditWithIdempotency`, `priorExecutionForKey`), calibration, graduation, autopilot loop, alert acknowledgement |
| Checkout reserve/release | **Not here** — checkout (Eric) calls the Slice 2 engine (`reserveStock`/`releaseReservation`) directly; those are not audited autopilot actions |

---

## What changes — the three executors

Each executor keeps its caller seam (same `action_kind`, same params, same audit tail) and swaps only the resolve + write. Targets resolve by `sku_id` (= `variant_dim.id` = `sku_dim.id`, the Slice 1 invariant).

### `adjust_price` (`app/lib/actions/adjust-price.server.ts`)
- **Before:** `setVariantPrice` → Shopify Admin.
- **After:** read the current price from `variant_dim.retail_price_cents` (the undo baseline), write the new price with a new focused helper **`setVariantPrice(shopId, variantId, priceCents)`** in the catalog layer (`app/lib/catalog/catalog.server.ts`) that updates `variant_dim` + calls `projectProductToSkuDim`. The price-cap guardrail (`max_price_change_pct`) and "never autopilot adjust_price unless graduated" policy are unchanged.

### `reallocate_inventory` (`app/lib/actions/inventory-relocate.server.ts` / `reallocate.server.ts`)
- **Before:** `inventoryAdjustQuantities` → Shopify.
- **After:** call Slice 2's **`createTransfer(shopId, variantId, fromLocationId, toLocationId, qty, "instant")`**. The pre-state captures the transfer plan (from/to/qty) for undo. Honors the autopilot inventory caps.

### `discontinue_sku` (`app/lib/actions/discontinue.server.ts`)
- **Before:** `productUpdate` status=archived → Shopify, + set the internal Do-Not-Reorder flag.
- **After:** read the current `product_dim.status` (undo baseline), call Slice 1's **`setProductStatus(shopId, productId, "archived")`** (resolving the product from the variant), keep setting the existing Do-Not-Reorder flag.

> Note on resolve: the product id comes from `variant_dim.product_id` (owned), not a Shopify GID. `setProductStatus` already re-projects `sku_dim` (Slice 1), so the engine sees the archive.

---

## Undo (kept working, re-pointed)

`app/lib/actions/undo.server.ts` already branches per kind; each branch's body swaps to owned:
- **`adjust_price` undo:** restore `pre_state.retail_price_cents` via `setVariantPrice`.
- **`reallocate_inventory` undo:** reverse the move — `createTransfer` with `from`/`to` swapped, same qty.
- **`discontinue_sku` undo:** `setProductStatus` back to `pre_state.status` (active/draft) + clear the Do-Not-Reorder flag.

The undo audit row, the graduation gate-2 "undo branch must exist" requirement, and `isGraduated`'s fail-safe-false all stay as-is — they only require the branch to work, which it now does against owned data.

---

## What stays exactly the same

- `action_audit` + `action_idempotency` (the shared tail) — `action_kind` is a free string; `params`/`pre_state`/`post_state` are JSON. No schema change.
- Calibration (`pair_calibration`), graduation (`GRADUATABLE_V1`), `NO_BRAINER`, the nightly `mu` training, the autopilot run loop (`runAutopilotForShop`) — all operate on action kinds + outcomes, unchanged.
- The merchant alert one-click path and the autopilot path both call the same re-pointed executors.
- The price-cap / inventory-cap guardrails and the `adjust_price`-never-auto-until-graduated policy.

---

## Out of scope (deferred)

- Checkout's `reserveStock` / `releaseReservation` (Eric's checkout, direct Slice 2 engine calls — not audited actions).
- A new autopilot-driven `publish` (draft→active) action — discontinue (unpublish) is the relevant autopilot kind; merchant publishing lives in the Slice 1 editor.
- New detectors / new graduatable kinds / autonomy-tier changes — that is the separate "autopilot onto owned data" follow-on; this slice only re-points the existing kinds' write target.
- Removing the now-dead Shopify write helpers (`setVariantPrice`-Shopify, `inventoryAdjustQuantities`) — they can be deleted once nothing references them; cleanup, not core.

---

## Success criteria

1. `adjust_price` writes the new price to `variant_dim` (+ re-projected `sku_dim`), records an audit row, and makes **no** Shopify call; undo restores the prior price.
2. `reallocate_inventory` moves stock via `createTransfer`, records an audit row, no Shopify call; undo reverses the transfer.
3. `discontinue_sku` archives the owned product (+ DNR flag), records an audit row, no Shopify call; undo un-archives.
4. The autopilot path and the merchant alert path both reach the owned writes through the unchanged executor seam.
5. Calibration/graduation/idempotency behave exactly as before (action kinds + audit unchanged) — verified by the existing action tests staying green.

---

## Risks

- **Undo correctness depends on a true pre-state.** The pre-state must be read from the owned tables *before* the write (old price, old status, the transfer plan), or undo restores the wrong value. Each executor reads its baseline first.
- **Resolve drift.** Resolving the product/variant must use owned ids (`variant_dim.id`/`product_dim`), not leftover Shopify GIDs; a stale GID-based resolve would target nothing.
- **Demo stores in `demo_mode`.** Showcase stores simulate side effects today; confirm the owned writes behave under `demo_mode` (or that demo_mode short-circuits before the write) so a demo action doesn't mutate real owned data unexpectedly.
- **Double-projection.** `setVariantPrice`/`setProductStatus`/`createTransfer` each re-project (`sku_dim` / `inventory_level_fact`); the executor must not also project separately, or it doubles work (harmless but wasteful).

---

## Next step

User reviews this spec → `writing-plans`. This is a single, focused plan (no split needed): add `setVariantPrice` to the catalog layer, re-point the three executor bodies + their undo branches, keep the existing action tests green. Build in an isolated worktree (`feat/store-action-executor`) off `origin/main`.
