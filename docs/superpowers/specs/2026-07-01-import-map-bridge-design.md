# import_map — durable mirror↔owned bridge — design

**Date:** 2026-07-01
**Platform-pivot step:** MVP build order **Step 9 — cutover spine**, slice 2 of 3 (`#13.promote`, the durable-bridge half). John's lane.
**Branch / worktree:** `feat/import-map` / `../calderyn-import-map` (off `origin/main`).
**Parent spec:** `docs/superpowers/specs/2026-06-27-calderyn-platform-pivot-design.md` (§ #13.promote).

---

## Purpose

Give every shop a durable, queryable **`import_map`**: a `(shop_id, entity_type, external_id [Shopify GID]) → owned_id [uuid]` bridge between the Shopify **mirror** tables (`sku_dim`, `location_dim`, `order_fact`, …) and Calderyn's **owned** tables (`product_dim`, `variant_dim`, `location_dim`). It is the missing keystone the parent spec calls out (§#13.promote): the **webhook-dedup key** for the cutover phases (`importing`/`dual_run`) so the same Shopify entity is never written to both the mirror and a *second* owned row, and the join key the **parity gate** (slice 3) will use to reconcile owned-vs-mirror counts.

## What already exists (do not rebuild)

Grounded against the current schema (2026-07-01):
- **Catalog promote** — `promote_shop_catalog(p_shop_id)` already promotes `sku_dim → product_dim/variant_dim` with `external_id` preserved and `variant_dim.id = sku_dim.id`. Done.
- **Inventory opening balances** — `20260629160200_inventory_seed.sql` already seeds `inventory_balance` from `inventory_level_fact`. Done.
- **Order history** — already covered: `order_fact` is the *shared* table holding BOTH Shopify-mirrored and Calderyn-native orders (`emit.server.ts` writes native orders into `order_fact`), and analytics already read it. A separate owned order-history table would be redundant (YAGNI) — **explicitly out of scope**.

The only genuinely-missing `#13.promote` piece is the **`import_map`** itself: there is no `(external_id ↔ owned_id)` bridge table anywhere in the repo today; the sole implicit bridge is the `variant_dim.id = sku_dim.id` value-equality (variants only) plus `external_id` columns.

## Scope

**In (this slice):**
- New `import_map` table (`shop_id`, `entity_type ∈ {product, variant, location}`, `external_id`, `owned_id`, `source_version`, `promoted_at`), RLS service-role only.
- One-time backfill from the already-promoted owned rows (`product_dim`/`variant_dim`/`location_dim` where `external_id is not null`).
- Extend `promote_shop_catalog` so it **records** product + variant map entries going forward (idempotent), keeping the promote path and the bridge in sync in one place.
- A TS accessor `app/lib/cutover/import-map.server.ts`: `lookupOwnedId`, `recordImportMapEntry`, `getImportMapCounts`.

**Out (later slices / explicitly not built):**
- Order/refund history promote — already covered by the shared `order_fact` (see above).
- The parity gate + go-live gates (slice 3; the gate *consumes* `getImportMapCounts`).
- Dual-write / dual_run webhook routing itself (this slice provides the dedup *key*; the routing that uses it is a later slice — `writesToOwned` is still `live`-only from slice 1).
- Going-forward **location** map recording during live mirroring (locations rarely change; the backfill covers all existing locations, and `recordImportMapEntry` is available for app-level use). Documented limitation.

## Decisions (locked)

1. **entity_type is a closed set** `{product, variant, location}` (check-constrained). Orders/refunds are excluded — `order_fact` already unifies both worlds, so they need no bridge.
2. **`source_version` is nullable.** Catalog/location dims carry no version watermark; it is recorded only when a source provides one (facts). The spec's point-in-time freeze/watermark (§#13) is a later go-live concern, not needed for identity mapping.
3. **Recording lives in `promote_shop_catalog`** (one place, idempotent via `on conflict do nothing`), so the bridge can never drift from the promote it mirrors — the same "one place" discipline the promote function already documents.
4. **Service-role-only RLS** (enable RLS, revoke grants, no policy) — matches the owned intake/ledger tables and slice-1's `cutover_transition`; the INFO `rls_enabled_no_policy` advisor is expected.

## Architecture

```
Shopify mirror                      import_map (bridge)                 owned SoT
  sku_dim.external_id (variant GID) ─┐   (shop_id, 'variant', ext_id) → variant_dim.id
  sku_dim.product_id (product GID)  ─┼─▶ (shop_id, 'product', ext_id) → product_dim.id
  location_dim.external_id (loc GID)─┘   (shop_id, 'location', ext_id)→ location_dim.id

  webhook (Shopify entity, external_id)
        │  lookupOwnedId(shop, type, external_id)
        ├── hit  → route to the existing owned row (no second owned row = no double-count)
        └── miss → new entity (record via recordImportMapEntry after promote)

  parity gate (slice 3): getImportMapCounts(shop) vs mirror/owned row counts
```

## Components

| Piece | File | Responsibility |
|---|---|---|
| Migration | `supabase/migrations/<ts>_import_map.sql` | `import_map` table + RLS; `create or replace promote_shop_catalog` (adds product/variant recording step); one-time backfill (catalog via re-run + locations direct) |
| Accessor | `app/lib/cutover/import-map.server.ts` (new) | `ImportMapEntityType`; `lookupOwnedId`; `recordImportMapEntry`; `getImportMapCounts` |
| Tests | `app/lib/cutover/__tests__/import-map.server.test.ts` (new) | accessor unit tests (in-memory Supabase stub) |

### `import_map` schema

```
id uuid pk · shop_id uuid → shops(id) on delete cascade
entity_type text check (entity_type in ('product','variant','location'))
external_id text not null                 -- Shopify GID
owned_id uuid not null                     -- product_dim/variant_dim/location_dim id
source_version bigint                       -- nullable; mirror watermark when known
promoted_at timestamptz not null default now()
unique (shop_id, entity_type, external_id) -- the dedup key
index (shop_id, entity_type, owned_id)     -- reverse lookups + parity counts
-- RLS enabled, grants revoked, no policy (service-role only)
```

### Accessor contract

```ts
type ImportMapEntityType = "product" | "variant" | "location";
lookupOwnedId(shopId, entityType, externalId): Promise<string | null>       // dedup/cutover
recordImportMapEntry(shopId, entityType, externalId, ownedId, sourceVersion?): Promise<void>  // upsert on (shop,type,ext)
getImportMapCounts(shopId): Promise<Record<ImportMapEntityType, number>>     // parity gate input
```

## Data flow & invariants (each gets a test)

1. **Backfill is complete + id-preserving.** After the migration, every `product_dim`/`variant_dim`/`location_dim` row with a non-null `external_id` has exactly one `import_map` row whose `owned_id` equals that row's `id`. (Verified on prod post-apply.)
2. **`lookupOwnedId` returns the owned id on a hit, null on a miss.** Shop-scoped; a foreign shop's mapping never leaks.
3. **`recordImportMapEntry` is idempotent** — re-recording the same `(shop, type, external_id)` updates in place (upsert on the unique key), never duplicates.
4. **`getImportMapCounts` returns per-entity counts** shop-scoped (0 for an entity with no rows).
5. **promote records the bridge** — after `promote_shop_catalog`, product + variant entries exist in `import_map` for every promoted row with an `external_id` (idempotent re-run adds nothing).

## Testing

Vitest, in-memory Supabase stub (repo pattern): `lookupOwnedId` hit/miss/foreign-shop; `recordImportMapEntry` insert + idempotent re-record; `getImportMapCounts` per-entity + empty. The migration's backfill correctness (invariant 1, 5) is verified by SQL against prod after apply (controller step), not a vitest.

## Housekeeping

- **Dashboard parity:** exempt — no merchant-facing surface (internal bridge + a server accessor).
- Migration sequences after the latest on `origin/main`.
- Pre-commit gate (CLAUDE.md) before commit; apply to prod Supabase via MCP after gate green; verify invariants 1/5 + `get_advisors`.
