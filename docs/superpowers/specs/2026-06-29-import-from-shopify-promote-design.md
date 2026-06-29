# Import from Shopify (Mirror → Owned Promote)

**Date:** 2026-06-29
**Status:** Design approved (brainstorm). Ready for spec review → implementation plan.
**Parent:** [Calderyn Platform Pivot — Build Map](./2026-06-27-calderyn-platform-pivot-design.md), feature `#13.promote` (the data-port half of cutover). Depends on Slice 1 (owned catalog) + Slice 2 (inventory). John's track.

---

## Goal

A per-merchant, on-demand, repeatable "Import from Shopify" that copies a merchant's existing Shopify **catalog, inventory, and order history** into Calderyn's owned tables. Slices 1 & 2 already wrote *one-time* scripts that promoted the existing mirror; this generalizes that into a callable, idempotent, per-shop operation with an import-map and an honest report — plus a connect step so a merchant who hasn't installed the app yet can still bring their store over.

Done when a merchant (warm-lead or freshly connected) can click "Import from Shopify," their products/variants/prices, stock + locations, and order history land in the owned tables, re-running is safe (no duplicates), and the merchant sees a clear report of what came over and what didn't.

This is the **data port only** — the final "go live and take real orders" flip needs the owned checkout (Eric's Slice 3) and is out of scope.

---

## Decisions (locked in brainstorm)

| Decision | Choice |
|---|---|
| Who it's for | **Both** — warm leads (app installed, data already mirrored) AND fresh merchants (connect Shopify first) |
| Promote engine | **Per-shop, repeatable, idempotent** — generalizes the Slice 1/2 backfill into a callable `promoteShopFromMirror(shopId)` keyed by an import-map |
| Scope | Catalog (products/variants/prices), inventory (current stock as opening balances) + locations, order history (records) |
| Order-history window | **12 months** for the import (configurable), pulled as a **background job**. The install backfill stays 30 days inline (fast first impression). |
| Customers | **Excluded** — fast-follow (`#13.customers`): stripped at ingest, needs a consented re-pull + Shopify Protected-Customer-Data approval + a secure PII store |
| Store look / theme | **Excluded** — not readable / not portable; AI-regeneration is a later slice |
| Go-live flip | **Out of scope** — taking real orders needs Eric's checkout (Slice 3) |

---

## The flow

```
Warm lead (app installed) ──────────────┐
                                          ├──►  PROMOTE (mirror → owned) ──►  report
Fresh merchant → Connect Shopify → pull ─┘
```

- **Warm lead:** their catalog/inventory/orders are already in the warehouse (the embedded app mirrors them). Skip connect → run promote.
- **Fresh merchant:** "Connect your Shopify store" via Shopify OAuth (reuse the dashboard's existing `exchangeCodeForToken` machinery) → run the **existing `backfillShop(shopDomain)`** (`app/lib/ingest/backfill.server.ts`) — the same code `afterAuth` runs on install — but with a **12-month order window** and **in the background** (a big store's history can't block the request). It pulls locations + products + variants + inventory levels + 12 months of orders into the warehouse → run promote. The pull logic is reused; the only change is parameterizing the window + running it off the request.

---

## The promote engine

A reusable `promoteShopFromMirror(shopId)` in `app/lib/import/promote.server.ts` that generalizes the Slice 1 catalog backfill + Slice 2 inventory seed into a **per-shop, idempotent** operation:

- **Catalog:** group `sku_dim` rows (for this shop) into `product_dim` + `variant_dim`, id-preserving (`variant_dim.id == sku_dim.id`, the Slice 1 invariant). Re-run safe via `on conflict do nothing` / update.
- **Locations + inventory:** ensure `location_dim` rows exist; seed `inventory_balance` from the latest `inventory_level_fact` observation per (variant, location) as opening on-hand.
- **Order history:** already mirrored as `order_fact`/`order_line_fact` (PII-stripped) and they reference `sku_id` = `variant_dim.id`, so once the catalog is promoted they resolve unchanged — no separate copy needed; the import just reports the count. **Window:** the import pulls **12 months** of orders (the install path keeps 30 days). This requires parameterizing `backfillShop`'s hardcoded `BACKFILL_DAYS = 30` into an argument and running the import's pull as a background job; the window is configurable and surfaced in the report.
- **Import-map:** the owned rows already carry `external_id` (the Shopify GID) from Slice 1; that linkage **is** the map. Add an `import_run` record (shop_id, started_at, finished_at, counts, status) for status + the report, and use `external_id` as the idempotency key so a second run updates rather than duplicates.

---

## What comes over / what doesn't

| Data | Imported? | Note |
|---|---|---|
| Products, variants, prices | ✅ | promote `sku_dim` → owned catalog |
| Stock + locations | ✅ | current counts become opening balances |
| Order history | ✅ | already mirrored; resolves once catalog is promoted |
| **Customers** | ❌ fast-follow | PII stripped at ingest; needs consented re-pull + Shopify PCD approval + secure store |
| **Store look / theme** | ❌ later | no theme access; not portable; AI-regenerated later |

---

## Merchant UI (dashboard)

A dashboard "Import from Shopify" surface (`cd-*`, `dashboard.api.*`):
- For a connected/warm shop: an "Import my Shopify store" button → progress → report.
- For a fresh shop: a "Connect Shopify" step first, then the same.
- The **report** is honest (rule 12): "Imported 240 products, 18 locations of stock, 1,100 past orders. **Not included:** your customer list and store design — here's why and what's next." No silent omissions.

---

## Out of scope (deferred)

- The go-live flip / cutover state machine (mirror→importing→dual_run→live) + the test-sale gate — needs Eric's checkout (the `#13` go-live half).
- Customer re-pull (`#13.customers`) + the buyer PII store (`#1`).
- Theme / SEO regeneration (`#13.aesthetics-seo`).
- Ongoing two-way Shopify **sync** — this is a one-time import (re-runnable), not a live mirror; owned tables are authoritative after import.
- **Stock-refresh on re-import** — re-running is dedup-only (`on conflict do nothing`), so it will NOT overwrite a balance that changed in Shopify since the first import. That's intentional for a one-time migration; a true "refresh from Shopify" would be a separate `on conflict do update` mode, surfaced in the report. Noted so it's a known behavior, not a silent gap.

---

## Success criteria

1. A warm-lead shop clicks Import → its products/variants/prices, stock + locations, and order-history count land/resolve in the owned tables.
2. A fresh shop connects Shopify, the initial pull populates the warehouse, then the same promote runs.
3. Re-running the import does **not** duplicate (same `external_id` → same owned row; counts stable).
4. The report names exactly what was imported and that customers + store design were not, with the reason.
5. The engine/Slices 1–2 invariants hold: `variant_dim.id == sku_dim.id`, inventory balances seeded, the existing detectors still resolve.

---

## Risks — locked down

Each former risk now has a concrete, verified resolution (checked against the code, 2026-06-29).

- **Initial bulk pull — RESOLVED, reuse `backfillShop`.** It already exists (`app/lib/ingest/backfill.server.ts`), runs inline in `afterAuth` on first install, and pulls **locations → `location_dim`, products+variants → `sku_dim`, inventory levels → `inventory_level_fact`, last-30-days orders → `order_fact`/`order_line_fact`**. The import calls it for a fresh connect; warm leads already have its output. The only changes: parameterize the order window (`BACKFILL_DAYS` → an argument) to pull **12 months** for the import, and run that pull as a **background job** so a large store's history doesn't block the request. The pull logic itself is reused.
- **Idempotency — LOCKED.** Two layers already upsert on `external_id`: `backfillShop` (`onConflict: shop_id,external_id`) and the Slice 1 catalog backfill (`on conflict do nothing`, id-preserving). The promote engine keys on `external_id` and upserts; the plan includes a **re-run test** asserting counts are stable on a second import. No duplicates possible.
- **Overselling — LOCKED.** The report is a success criterion with **fixed copy** that always names the exclusions ("Not included: your customer list and store design"). It is not a free-text field that can omit them. Matches the pivot's "stats stick ≠ equity sticks."
- **Order-history resolution — LOCKED.** Order lines reference `sku_id` = `sku_dim.id`, and the Slice 1 promote preserves `variant_dim.id == sku_dim.id`. So promoted order lines resolve to the owned variant by construction. The promote engine runs **catalog first**, then reports order counts — no window where lines point at an un-promoted variant.
- **Scopes / re-consent — LOCKED.** `backfillShop` uses `fetchLocations`/`fetchProducts`/`fetchRecentOrders` = the app's existing `read_locations, read_products, read_inventory, read_orders` scopes. A fresh OAuth connect grants exactly these (the same the embedded app holds). Customers are excluded *precisely because* `read_customers` is **not** in scope — consistent, not an accident.

**Residual (accepted, not blocking):** the import pulls **12 months** of order history (the install path stays 30 days). The window is a configurable argument, surfaced in the report — a merchant wanting more than a year can have it dialed up. Everything else is resolved against existing, tested code.

---

## Next step

User reviews this spec → `writing-plans`. A single plan: the promote engine + `import_run` + the dashboard trigger/report, plus the fresh-merchant connect that calls the existing `backfillShop` (no large net-new pull — that risk is resolved). Build in an isolated worktree (`feat/shopify-import`) off `origin/main`.
