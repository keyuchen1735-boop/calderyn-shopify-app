# Org-mode + write-back routing — design

**Date:** 2026-07-01
**Platform-pivot step:** MVP build order **Step 9 — cutover spine**, slice 1 of 3 (`#13` org_mode state machine + `extend:write-back`, the routing half). John's lane (owned-commerce data core + autopilot).
**Branch / worktree:** `feat/org-mode-writeback` / `../calderyn-cutover` (off `origin/main` @ `4957fbf`).
**Parent spec:** `docs/superpowers/specs/2026-06-27-calderyn-platform-pivot-design.md` (§ Step 9).

---

## Purpose

Give each store a **cutover mode** and route the two store-mutating autopilot actions — price changes and inventory moves — to Calderyn's **own** tables vs the Shopify Admin API based on that mode. This is the plumbing that lets a pilot merchant eventually run their store ON Calderyn: after cutover, an autopilot price change lands in the owned price column and an inventory move decrements the owned ledger, not Shopify.

Every existing shop defaults to `mirror`, which routes to Shopify exactly as today, so **shipping this slice changes no live behavior** until a shop is deliberately moved to `live`.

## Scope

**In (this slice):**
- `shops.org_mode` state column (`mirror | importing | dual_run | live`, default `mirror`) + an append-only `cutover_transition` audit table.
- `app/lib/cutover/org-mode.server.ts`: read, legal-transition-enforced write, and a `writesToOwned(mode)` router predicate.
- Route the terminal writes of `adjust-price.server.ts` and `inventory-relocate.server.ts`: when `writesToOwned`, write owned tables; otherwise the existing Shopify-Admin path, unchanged.

**Out (later Step-9 slices):**
- The **parity gate** and the **payment-cleared go-live gate** (the checks before a shop may reach `live`) — a separate slice, and the go-live gate depends on Eric's checkout+payments being production-live.
- The **merchant "cut me over" UI** — transitions in this slice happen only via the guarded `transitionOrgMode` server function.
- `#13.promote` extensions (inventory opening balances + order history + import_map).
- `dual_run` **dual-writing / compare** — a parity-gate concern; here `dual_run` still writes to Shopify (see Decisions).
- Other store actions (discontinue_sku, PO drafts) — this slice covers only the two the spec names (price + inventory).

## Decisions (locked)

1. **Binary routing:** `writesToOwned(mode)` is true **only for `live`**. `mirror`/`importing`/`dual_run` all keep writing to Shopify. Dual-write-and-compare in `dual_run` belongs to the later parity-gate slice; keeping it binary here keeps the slice thin and the write surface small.
2. **Default `mirror`, zero live change:** the migration defaults every existing shop to `mirror`; nothing in this slice transitions a shop, so no store routes to owned tables on ship.
3. **State machine enforced like the order spine:** legal transitions only, one append-only audit row per transition, compare-and-set on the current mode — mirroring `transitionOrder` (`app/lib/order/order.server.ts`).

## Architecture

```
shops.org_mode:  mirror ─▶ importing ─▶ dual_run ─▶ live      (rollback: live→dual_run, dual_run→mirror)

  autopilot action (adjust_price | inventory move)
        │
        ▼   getOrgMode(shopId) → writesToOwned(mode)?
        ├── false (mirror/importing/dual_run) ─▶ Shopify Admin  (today's path, untouched)
        └── true  (live) ─▶ owned:  price → variant_dim.retail_price_cents
                                    stock → inventory engine (Slice 2: adjustStock / createTransfer)
```

## Components

| Piece | File | Responsibility |
|---|---|---|
| Migration | `supabase/migrations/<ts>_org_mode.sql` | `shops.org_mode` (text, default `mirror`, check-constrained) + `cutover_transition` audit table (RLS, service-role) |
| Mode module | `app/lib/cutover/org-mode.server.ts` (new) | `OrgMode` type; `getOrgMode(shopId)`; `transitionOrgMode(shopId, to, reason?)` (legal-transition + audit + compare-and-set); `writesToOwned(mode): boolean` |
| Price routing | `app/lib/actions/adjust-price.server.ts` | branch on `writesToOwned`: owned → update `variant_dim.retail_price_cents` by owned variant id; else → existing `setVariantPrice(admin, …)` |
| Inventory routing | `app/lib/actions/inventory-relocate.server.ts` | branch on `writesToOwned`: owned → inventory engine (`createTransfer`/`adjustStock`); else → existing `inventoryAdjustQuantitiesForShop(…, admin, …)` |
| Owned-write helpers | `app/lib/actions/owned-writes.server.ts` (new) | `setOwnedVariantPrice(shopId, variantId, priceCents)` + `applyOwnedInventoryMove(...)` — keep the executors readable; wrap the Slice-1 price column + Slice-2 engine calls |

### `org_mode` state machine (legal transitions)

```
mirror    → importing
importing → dual_run,  mirror        (abort back to mirror)
dual_run  → live,      mirror        (rollback)
live      → dual_run                 (emergency rollback off owned writes)
```

`transitionOrgMode` throws on any transition not in this set (fail visibly), inserts the `cutover_transition` audit row BEFORE the `shops.org_mode` UPDATE, and compare-and-sets on the from-mode so a concurrent transition can't be silently overwritten — the exact discipline `transitionOrder` uses.

### `cutover_transition` (audit)

```
id uuid pk · shop_id uuid → shops(id) · from_mode text · to_mode text
reason text · occurred_at timestamptz default now()
-- RLS enabled, service-role only (matches the owned intake/ledger tables)
```

## Data flow & invariants (each gets a test)

1. **Default `mirror` → Shopify path, unchanged.** With no transition, `getOrgMode` returns `mirror`, `writesToOwned` is false, and both executors take their existing Shopify-Admin branch byte-for-byte. A test asserts the owned branch is NOT taken at `mirror`.
2. **`live` → owned tables.** At `live`, `adjust_price` writes `variant_dim.retail_price_cents` (owned variant id, no Shopify variant needed) and the inventory move hits the owned engine; the Shopify Admin client is not called. Tested per executor.
3. **Legal transitions only.** `transitionOrgMode` accepts the transitions above and throws on the rest (e.g. `mirror→live`), writing nothing on an illegal move.
4. **Audit + compare-and-set.** Each successful transition writes exactly one `cutover_transition` row and moves `shops.org_mode` only when it still holds the expected from-mode (0-row update → throw, never a silent no-op).
5. **Owned price write is bounded like the Shopify one.** The owned branch still runs the existing guardrail cap (`max_price_change_pct`) — the routing changes the WRITE target, not the safety envelope.

## Testing

Vitest, in-memory Supabase fake (repo pattern):
- `org-mode.server`: `getOrgMode` default `mirror`; `transitionOrgMode` legal path writes audit + updates; illegal transition throws + writes nothing; compare-and-set 0-row → throws; `writesToOwned` true only for `live`.
- `adjust-price.server`: `mirror` → `setVariantPrice(admin)` called, owned write not; `live` → `variant_dim.retail_price_cents` updated, `admin` not called; guardrail cap still applied on the owned branch.
- `inventory-relocate.server`: `mirror` → `inventoryAdjustQuantitiesForShop(admin)` called; `live` → owned engine called, `admin` not.

## Housekeeping

- **Dashboard parity:** exempt — no merchant-facing surface in this slice (the cut-over UI is a later slice). Internal routing + a guarded server function only.
- Migration numbering sequences after the latest on `origin/main` (`20260701120000_variant_shipping.sql`).
- Pre-commit gate (CLAUDE.md) before any commit.
- The Shopify-Admin executor paths are **left intact** — this slice adds a branch, it does not remove the existing behavior (needed for every non-`live` shop, which is all of them today).
