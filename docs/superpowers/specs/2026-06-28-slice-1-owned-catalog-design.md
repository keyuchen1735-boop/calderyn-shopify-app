# Slice 1 — Own the Catalog (Full Editor, Purely Owned)

**Date:** 2026-06-28
**Status:** Design approved (brainstorm). Ready for spec review → implementation plan.
**Parent:** [Calderyn Platform Pivot — Build Map](./2026-06-27-calderyn-platform-pivot-design.md), feature `#5`. Depends on Slice 0 (owned tenant identity / `shops.id`).

---

## Goal

Calderyn owns its product catalog. Today the catalog is a flat, read-only **mirror of Shopify** (`sku_dim`). After this slice, products are first-party Calderyn data that a merchant creates and edits directly in the dashboard — the authority that a future storefront/checkout reads price and status from. No Shopify sync.

Slice 1 is **done** when a merchant can create, edit, and organise products (with images, options/variants, and collections) in the dashboard, the data lives in owned tables, and the existing engine keeps running unchanged.

---

## Decisions (locked in brainstorm)

| Decision | Choice |
|---|---|
| Catalog source of truth | **Purely owned** — merchant creates/edits in Calderyn; NO Shopify mirror or sync |
| v1 editing scope | **Full editor** — image gallery, options→variant matrix, per-variant stock count, collections, vendor, tags, description |
| Stock counts | **Editable number per variant now** (a static on-hand quantity the merchant sets). The smart part (auto-decrement on sale, oversell guard, reservations, multi-location) stays Slice 2 — it needs checkout. This number becomes Slice 2's opening balance. |
| Where it lives | **Dashboard only** (`cd-*` admin + `dashboard.api.*`); NOT the embedded Polaris app (being retired by the pivot) |
| Image storage | **Supabase Storage** (`product-media` private bucket) — interim home until the dedicated asset-CDN slice (`#9`) |
| Existing engine | **Unchanged** — `sku_dim` becomes a compatibility VIEW over the new tables; current demo data is promoted in first |

---

## Data model (owned tables)

New tables, all scoped by the internal `shops.id` UUID (unchanged tenant key):

- **`product_dim`** — `id uuid pk`, `shop_id`, `external_id text null` (kept as a "where it came from" link for promoted demo rows; never synced), `handle`, `title`, `status text check (draft|active|archived)`, `vendor`, `product_type`, `description`, `tags text[]`, `published_at`, `created_at`, `updated_at`.
- **`variant_dim`** (promotes `sku_dim`) — `id uuid pk`, `shop_id`, `product_id → product_dim`, `external_id text null`, `sku`, `title`, `retail_price_cents`, `unit_cost_cents`, `currency`, `inventory_policy`, `inventory_tracked bool`, `inventory_on_hand int default 0` (static editable count; becomes Slice 2's opening balance), `requires_shipping bool`, `position`.
- **`product_option`** — `id`, `product_id`, `name` (e.g. "Size"), `position`; **`product_option_value`** — `id`, `option_id`, `value` (e.g. "M"), `position`.
- **`variant_option_value`** — join: which option-values a variant represents (a variant = one combination).
- **`product_media`** — `id`, `product_id`, `storage_path`, `alt`, `position`, `is_primary bool`.
- **`collection_dim`** — `id`, `shop_id`, `handle`, `title`, `description`; **`product_collection`** — join `(product_id, collection_id)`.

All credential/PII-free, but tenant-scoped: keep the existing `shop_id` + service-role manual-scoping convention; tighten with RLS in the later RLS-hardening slice (`#12`).

### Engine compatibility (the load-bearing part)

~70 downstream detectors/views read the flat `sku_dim` (`v_skus_flat_*`, `sku_pnl`, `sku_velocity`, `stockout_forecast`, etc.). To avoid breaking them:

1. **Promote** current `sku_dim` rows into `product_dim` + `variant_dim`: group existing rows by `sku_dim.product_id` (a Shopify GID string) to derive products; copy each row into `variant_dim` carrying `retail_price_cents`, `unit_cost_cents`, `inventory_policy`, `inventory_tracked`, `vendor`, `tags`, `grams`. Keep the old GID in `external_id`.
2. **Replace `sku_dim` with a VIEW** over `variant_dim` joined to `product_dim`, exposing the exact same column names/types the engine reads today (including `product_status`, `vendor`, `collections`, `grams`, `retail_price_cents`). Detectors keep resolving with zero changes.
3. The catalog **write path moves from ingest to the editor.** The Shopify product mirror (`applyProduct` in `ingest/transform.server.ts`) is no longer the catalog authority; for owned stores it is dormant. (Order/inventory/ads ingest is untouched by this slice.)

---

## Where it lives + surfaces

Dashboard surface only (`app/routes/dashboard.*` + `app/components/dashboard/*`, `cd-*` design system, Lucide via `CDIcon`). Server data via `dashboard.api.*` routes (existing CSRF guard + rate limiter).

- **Product list** — search, filter by status, paginate.
- **Product editor** — title, status, vendor, tags, description; **image gallery** (upload, reorder, set primary); **options → variant grid** (define options + values; the grid of variants is generated from the combinations; set SKU + price + track-stock + stock count per variant); **collections** (assign to one or more).
- **Collections manager** — create/edit collections.

All catalog mutations validate at the action boundary (shape DTOs; never trust `FormData`); return `redirect()` after a successful write.

## Images

Private Supabase Storage bucket `product-media`. Upload via a `dashboard.api.*` endpoint that streams to Storage and records a `product_media` row (`storage_path`). Reads use signed URLs (or public-read on the bucket if simpler for v1). Reuses the existing bug-report Storage pattern — no new vendor, no new dependency.

---

## Out of scope (deferred on purpose)

- Checkout / storefront (later slices) — this slice has no buyer-facing surface.
- The **smart** inventory ledger — Slice 2 (`#4`): auto-decrement on sale, oversell guard, reservations, multi-location allocation. Slice 1 stores a plain editable on-hand count per variant (single, location-less); Slice 2 turns that into the decrementable balance using it as the opening number.
- Shopify sync / "Connect Shopify" import (parked, undecided).
- Dedicated owned asset CDN (`#9`) — Supabase Storage stands in.
- Bulk import/CSV, product duplication, and a publishing/scheduling workflow (fast-follow editor richness).

---

## Success criteria

1. A merchant creates a product in the dashboard with a title, gallery, options (Size/Color), generated variants (each with SKU + price + stock count), and a collection — and it persists to the owned tables.
2. Editing and archiving a product works; the product list reflects changes.
3. The existing engine (detectors, `v_skus_flat_*`, ROAS, grades) runs unchanged against the `sku_dim` compatibility view.
4. Existing demo/showcase products appear intact in the new editor after promotion.
5. Images upload to Supabase Storage and display in the editor.

---

## Risks

- **`sku_dim`-as-view fidelity.** The view must expose every column the ~70 downstream consumers read, with matching types. A missing/renamed column silently breaks a detector. Mitigation: enumerate every `sku_dim` reader before cutover; the view is the single compatibility contract.
- **Promotion grouping.** Deriving products from `sku_dim.product_id` (a Shopify GID string) must handle null/odd GIDs without collapsing distinct products or stranding variants.
- **Write-path split.** The ingest `applyProduct` upsert and the new editor must not both claim `sku_dim`/variant authority. For owned stores the editor is authoritative; the mirror upsert is disabled, not left racing.
- **No RLS yet.** Owned catalog tables holding source-of-truth raise tenant-isolation stakes vs. the read-only mirror; relies on correct `shop_id` scoping until `#12`.
- **Dashboard-only break from the parity rule.** This intentionally skips the embedded Polaris app (being retired) — note it explicitly so it doesn't read as a missed mirror.

---

## Next step

User reviews this spec → `writing-plans` for the implementation plan. Build in an isolated worktree (`feat/owned-catalog`) off `origin/main`.
