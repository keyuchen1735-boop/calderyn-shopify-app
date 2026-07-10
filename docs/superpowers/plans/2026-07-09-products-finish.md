# Products Area Finish + Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring every dashboard Products section (Catalog, Inventory, Purchase orders, Transfers, Collections, Locations, Product editor, New product flow) to a finished, Shopify-competitive state with agentic touches.

**Architecture:** All work in worktree `C:\Users\famou\Desktop\calderyn-products-finish` (branch `feat/products-finish`, based on origin/main after the Orders power-tools merge). Every list screen follows the Orders rework pattern (`Orders.tsx` + `OrdersToolbar.tsx` + `orders-list-state.ts` on this branch); every API route follows the catalog route pattern (`requireDashboardSession` → `dashboardJson`, `requireSameOrigin` on writes, hand-rolled validators, `{ error, message }` failures). New shared logic goes in `app/lib/catalog/` or `app/lib/dashboard/`.

**Tech Stack:** Remix (Vite) + React 18, TypeScript strict, Supabase Postgres (service-role client, explicit `.eq("shop_id", ...)` tenancy), vitest, `cd-*` design system, Lucide via `CDIcon`.

**Spec:** `docs/superpowers/specs/2026-07-09-products-finish-design.md` (committed on this branch). Read it before starting any task.

## Global Constraints

- TypeScript strict; no `any` (prefer `unknown` + narrowing). `npx tsc --noEmit` must stay green after every task.
- Never import a `.server.ts` module from client code. Client code talks only to `/dashboard/api/*` via `app/lib/dashboard/client.ts` helpers (`apiGet`, `apiSend`).
- Every route: `requireDashboardSession(request)` first; `requireSameOrigin(request)` before any write; tenancy from `session.shopId` only — never from the request body.
- UI: `cd-*` primitives from `app/components/dashboard/ui.tsx` (Card, Btn, Pill, Placeholder, Segmented, TableSkeleton, SectionTitle). Icons ONLY via `CDIcon` (`app/components/dashboard/icons.tsx`); to add one, import from `lucide-react` and add one line to `CD_ICONS`.
- No new npm dependencies. Do not touch `@remix-run/*` pins (exact 2.16.7).
- No browser-visible AI/provenance/dev-tool comments or strings anywhere (CLAUDE.md "Browser-visible source hygiene"). Keep JSX comments technical and product-neutral.
- PostgREST clamps every response at 1000 rows; paginate server-side; aggregate in SQL, not in route code over unbounded reads.
- Migrations: `supabase/migrations/YYYYMMDDHHMMSS_snake_case.sql`, RPCs `create or replace function public.<name>(p_shop_id uuid, ...) ... language plpgsql set search_path = ''`, errors via `raise exception 'code'`. The ORCHESTRATOR applies migrations to prod via supabase MCP — a task only commits the file and says so in its report.
- Tests: vitest (`npx vitest run <file>`). Pure logic in framework-free modules next to the screen (pattern: `app/components/dashboard/screens/orders-list-state.ts` + `__tests__/orders-list-state.test.ts`). Component smoke tests via `renderToStaticMarkup` + `makeApp` factory (pattern: `__tests__/import-shopify-auth-link.test.tsx`).
- Each task ends: `npx tsc --noEmit` green, `npx vitest run` green for touched tests, then commit with the given message + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer. One commit per task. Never `--no-verify`.
- Screen-cache idiom for list screens: seed `useState(() => cachedScreenData<T>(KEY))`, write through with `cacheScreenData(KEY, fresh)`, only the DEFAULT filter state seeds/writes cache (see Orders.tsx `isDefaultView`, lines ~355-390).

---

### Task 1: Catalog list upgrades (thumbnails, variant count, clear-search, sort)

**Files:**
- Modify: `app/lib/catalog/catalog.server.ts` (listProducts, lines 29-129)
- Modify: `app/routes/dashboard.api.catalog.products._index.tsx` (loader)
- Modify: `app/lib/dashboard/client.ts` (fetchProducts, line 1312)
- Modify: `app/components/dashboard/screens/Catalog.tsx`
- Create: `app/components/dashboard/screens/catalog-list-state.ts`
- Test: `app/components/dashboard/screens/__tests__/catalog-list-state.test.ts`

**Interfaces:**
- Consumes: `ProductSummaryVM` (client.ts:1251 — already carries `imageUrl`, `variantCount`), `catalogCacheKey(search, status)` (screen-cache.ts).
- Produces: `type CatalogSort = "updated" | "title_asc" | "title_desc"`; `catalogSortToOrder(sort): { column: "updated_at" | "title"; ascending: boolean }` (pure, in catalog-list-state.ts); `fetchProducts` gains optional `sort?: CatalogSort`; `catalogCacheKey` unchanged (cache seeds only the default `updated` sort — non-default sort is live-fetch-only, mirroring Orders' isDefaultView rule).

- [ ] **Step 1: Write the failing test**

```ts
// app/components/dashboard/screens/__tests__/catalog-list-state.test.ts
import { describe, expect, it } from "vitest";
import { catalogSortToOrder, CATALOG_SORTS } from "../catalog-list-state";

describe("catalogSortToOrder", () => {
  it("maps updated to updated_at desc", () => {
    expect(catalogSortToOrder("updated")).toEqual({ column: "updated_at", ascending: false });
  });
  it("maps title_asc / title_desc to title", () => {
    expect(catalogSortToOrder("title_asc")).toEqual({ column: "title", ascending: true });
    expect(catalogSortToOrder("title_desc")).toEqual({ column: "title", ascending: false });
  });
  it("exposes exactly the three sorts", () => {
    expect(CATALOG_SORTS.map((s) => s.value)).toEqual(["updated", "title_asc", "title_desc"]);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL (module not found)**: `npx vitest run app/components/dashboard/screens/__tests__/catalog-list-state.test.ts`

- [ ] **Step 3: Implement `catalog-list-state.ts`**

```ts
// Pure list-state helpers for the Catalog screen. Framework-free so both the
// screen and the server route share one definition of the sort vocabulary.
export type CatalogSort = "updated" | "title_asc" | "title_desc";

export const CATALOG_SORTS: Array<{ value: CatalogSort; label: string }> = [
  { value: "updated", label: "Recently updated" },
  { value: "title_asc", label: "Title A–Z" },
  { value: "title_desc", label: "Title Z–A" },
];

export function isCatalogSort(v: string): v is CatalogSort {
  return v === "updated" || v === "title_asc" || v === "title_desc";
}

export function catalogSortToOrder(sort: CatalogSort): { column: "updated_at" | "title"; ascending: boolean } {
  if (sort === "title_asc") return { column: "title", ascending: true };
  if (sort === "title_desc") return { column: "title", ascending: false };
  return { column: "updated_at", ascending: false };
}
```

- [ ] **Step 4: Test passes**; then server: `listProducts` accepts `sort?: CatalogSort` — import `catalogSortToOrder` (the module is framework-free, safe server-side) and replace the fixed `.order("updated_at", ...)` with the mapped column, keeping `.order("id", { ascending: false })` as tiebreaker. Route loader: parse `sort` from the query string, validate with `isCatalogSort`, pass through. Client `fetchProducts`: add `sort` to opts and query string (omit when `"updated"`).

- [ ] **Step 5: Catalog.tsx UI** — four changes, mirroring existing idioms:
  1. **Thumbnails + variant count**: change `GRID` to `"44px 2fr 1fr 1fr 1fr"`; header gets a leading empty `<span aria-hidden="true" />`. Each row's first cell:
```tsx
<div style={{ width: 36, height: 36, borderRadius: 8, overflow: "hidden", background: "var(--gray-bg)", display: "flex", alignItems: "center", justifyContent: "center" }}>
  {p.imageUrl ? (
    <img src={p.imageUrl} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
  ) : (
    <CDIcon name="bag" size={15} />
  )}
</div>
```
  The Product cell gains a caption line: `{p.variantCount} variant{p.variantCount === 1 ? "" : "s"}` (only when `variantCount > 1`).
  2. **Clear-search**: wrap the search input in a `position: relative` div; when `search` is non-empty render an inset button (`aria-label="Clear search"`, `CDIcon name="x" size={13}`) that calls `setSearch("")`.
  3. **Sort select**: `<select className="cd-input" value={sort} onChange=... aria-label="Sort products">` over `CATALOG_SORTS`, placed next to the `Segmented`. Sort state resets nothing else; include `sort` in the load effect deps and pass to `fetchProducts`. Cache: only read/write `catalogCacheKey(query, statusParam)` when `sort === "updated"` (add `&& sort === "updated"` to the cached-read and `cacheScreenData` call), so non-default sorts never poison the seeded cache.
  4. `loadMore` passes `sort` too.

- [ ] **Step 6: Verify + commit**: `npx tsc --noEmit` && `npx vitest run app/components/dashboard/screens/__tests__/catalog-list-state.test.ts` → commit `dashboard/Catalog: thumbnails, variant count, clear-search, sort`.

---

### Task 2: Catalog bulk actions (select, status, archive, add-to-collection)

**Files:**
- Create: `app/lib/catalog/bulk.server.ts`
- Create: `app/routes/dashboard.api.catalog.products.bulk.status.tsx`
- Create: `app/routes/dashboard.api.catalog.products.bulk.collection.tsx`
- Modify: `app/lib/dashboard/client.ts` (new bulk fns after archiveProduct)
- Modify: `app/components/dashboard/screens/Catalog.tsx`
- Test: `app/lib/catalog/bulk.server.test.ts`

**Interfaces:**
- Consumes: `setProductStatus(shopId, productId, status)` (catalog.server.ts:528), `listCollections` for the picker (already fetched client-side via `fetchCollections`). Orders bulk pattern: `app/lib/order/bulk.server.ts` (`validateBulkOrderIds`, `runBulkOrderAction`, `MAX_BULK_ORDERS`) — read it first and mirror.
- Produces:
  - `validateBulkProductIds(raw: unknown): { ok: true; productIds: string[] } | { ok: false; code: "invalid_product_ids" | "too_many_products"; message: string }` — array of non-empty strings, deduped, raw length ≤ 100 pre-dedupe, ≤ `MAX_BULK_PRODUCTS = 25` post-dedupe.
  - `runBulkProductAction(productIds, fn, batchSize = 5): Promise<BulkProductOutcome[]>` where `type BulkProductOutcome = { product_id: string; ok: true } | { product_id: string; ok: false; error: string }` (Promise.allSettled batches; CalderynError message passes through, anything else → "Something went wrong.").
  - Routes: POST `{ product_ids: string[], status: "active" | "draft" | "archived" }` → `{ results }`; POST `{ product_ids, collection_id: string }` → `{ results }` (insert into `product_collection` with upsert `onConflict: "product_id,collection_id", ignoreDuplicates: true`, after verifying the collection belongs to the shop via `collection_dim` lookup → 404 `collection_not_found`).
  - Client: `bulkSetProductStatus(productIds: string[], status: "active" | "draft" | "archived"): Promise<{ results: BulkProductResultVM[] }>`; `bulkAddProductsToCollection(productIds: string[], collectionId: string)`; `type BulkProductResultVM = { productId: string; ok: boolean; error?: string }` (map snake_case wire → camel in client).

- [ ] **Step 1: Failing tests** for the validator + runner:

```ts
// app/lib/catalog/bulk.server.test.ts
import { describe, expect, it } from "vitest";
import { validateBulkProductIds, runBulkProductAction, MAX_BULK_PRODUCTS } from "./bulk.server";

describe("validateBulkProductIds", () => {
  it("accepts and dedupes string ids", () => {
    const r = validateBulkProductIds(["a", "b", "a"]);
    expect(r).toEqual({ ok: true, productIds: ["a", "b"] });
  });
  it("rejects non-arrays, empty arrays, and non-string members", () => {
    for (const bad of [null, "x", [], ["a", 3], [""]]) {
      expect(validateBulkProductIds(bad).ok).toBe(false);
    }
  });
  it("rejects more than MAX_BULK_PRODUCTS after dedupe", () => {
    const ids = Array.from({ length: MAX_BULK_PRODUCTS + 1 }, (_, i) => `p${i}`);
    const r = validateBulkProductIds(ids);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("too_many_products");
  });
});

describe("runBulkProductAction", () => {
  it("returns per-product outcomes and downgrades rejections", async () => {
    const results = await runBulkProductAction(["a", "b"], async (id) => {
      if (id === "b") throw new Error("boom");
    });
    expect(results).toEqual([
      { product_id: "a", ok: true },
      { product_id: "b", ok: false, error: "Something went wrong." },
    ]);
  });
});
```

- [ ] **Step 2: Run — FAIL.** **Step 3: Implement `bulk.server.ts`** mirroring `app/lib/order/bulk.server.ts` exactly (same shape, product vocabulary; CalderynError check via `err instanceof CalderynError ? err.message : "Something went wrong."`). **Step 4: Tests pass.**

- [ ] **Step 5: Routes.** Both: `requireSameOrigin` → session → POST-only → `parseJsonObjectBody` (null → 400 `bad_body`) → `validateBulkProductIds(body.product_ids)` → 422 with code on failure. Status route additionally: `body.status` must be one of the three literals else 422 `invalid_status`; run `setProductStatus(session.shopId, id, status)` per id via `runBulkProductAction`. Note `setProductStatus` silently no-ops on a foreign/missing id (it's an `.eq(shop_id)` UPDATE) — make it strict here: pre-check ownership with one `.in("id", productIds).eq("shop_id", ...)` select and mark non-owned ids `{ ok: false, error: "Not found." }` without calling fn. Collection route: verify collection ownership once up front (404), pre-check product ownership the same way, then per-id upsert into `product_collection`.

- [ ] **Step 6: Client fns** (after `archiveProduct`, mirroring `bulkFulfillOrders` in orders-client.ts:339 but without idempotency key — status/membership writes are naturally idempotent).

- [ ] **Step 7: Catalog UI.** Mirror Orders.tsx selection precisely (read Orders.tsx:160-230 + 506-560 + 680-716 first):
  - `GRID` gains a leading `"auto "` column for checkboxes; header select-all checkbox `aria-label="Select all products on this page"`; row checkboxes wrapped in `onClick={(e) => e.stopPropagation()}` (rows are `<button>` — wrap the checkbox in a `<span role="presentation">` INSIDE the button? No: move the row from `<button>` to `<div role="button" tabIndex={0} onKeyDown={Enter/Space → navigate}>` so a real checkbox can nest legally).
  - `const [selected, setSelected] = useState<Set<string>>(new Set())`, cleared when `products` identity changes (`useEffect(() => setSelected(new Set()), [products])`).
  - Bulk bar (rendered when `selected.size > 0`, above the table, in a `Card`): `{selected.size} selected` + `Btn small icon="check"` Set active + `Btn small` Set draft + `Btn small icon="archive"` Archive (label flips to Unarchive when `status === "archived"` view: archived view sends `status: "draft"`... NO — Unarchive sets `"draft"`; label it "Unarchive to draft") + Add-to-collection: `<select className="cd-input">` over collections (fetch via `fetchCollections()` on first selection, error → toast) + `Btn small icon="tag"` Add. Archive confirms via `window.confirm(\`Archive ${selected.size} products?\`)`.
  - After any bulk call: summarize like Orders (`summarizeBulk` idiom — `ok of n` + up to 3 failed titles via a `titleById` Map), clear selection, re-run the current fetch (extract the effect body into a `load()` callback so both paths share it).
- [ ] **Step 8: Verify + commit**: tsc + vitest (both test files) → `dashboard/Catalog: bulk select with status, archive, add-to-collection`.

---

### Task 3: Inventory list read (SQL RPC + endpoint + client)

**Files:**
- Create: `supabase/migrations/20260710120000_inventory_list_fn.sql`
- Create: `app/lib/catalog/inventory-list.server.ts`
- Create: `app/routes/dashboard.api.catalog.inventory._index.tsx`
- Modify: `app/lib/dashboard/client.ts` (inventory section)
- Test: `app/lib/catalog/inventory-list.server.test.ts`

**Interfaces:**
- Consumes: `inventory_balance` (variant_id, location_id, on_hand, reserved, incoming, available, reorder_point), `variant_dim` (id, product_id, sku, title, shop_id), `product_dim` (id, title, status), `action_audit` (action_kind, params, outcome, created_at) — see spec Architecture notes.
- Produces:
  - RPC `public.inventory_list(p_shop_id uuid, p_search text, p_stock text, p_limit int, p_offset int)` returning rows `(variant_id uuid, product_id uuid, sku text, variant_title text, product_title text, on_hand bigint, reserved bigint, incoming bigint, available bigint, low boolean, location_count bigint, single_location_id uuid, total_count bigint)`.
  - `listInventory(shopId, opts: { search?: string; stock?: "low" | "out"; limit?: number; offset?: number }): Promise<{ rows: InventoryRow[]; total: number }>` in inventory-list.server.ts, plus `attachRestockPresence(shopId, rows)` which decorates rows with `restock: { auditId: string; createdAt: string; outcome: string } | null` from the latest ≤30-day `create_po_draft` audit row whose `params->'po'->'lines'->0->>'sku'` matches the row's sku.
  - Client: `InventoryRowVM` (camelCase mirror incl. `restock`), `fetchInventoryList(opts): Promise<{ rows: InventoryRowVM[]; total: number }>` → GET `/dashboard/api/catalog/inventory?search=&stock=&offset=`.

- [ ] **Step 1: Migration.** Write exactly:

```sql
-- Shop-wide inventory list: one row per tracked variant with balance rollups,
-- search, stock filter, and windowed total, so the dashboard Inventory screen
-- can paginate without a client-side group-by (PostgREST cannot aggregate).
create or replace function public.inventory_list(
  p_shop_id uuid,
  p_search text default null,
  p_stock text default null,
  p_limit int default 50,
  p_offset int default 0
) returns table (
  variant_id uuid,
  product_id uuid,
  sku text,
  variant_title text,
  product_title text,
  on_hand bigint,
  reserved bigint,
  incoming bigint,
  available bigint,
  low boolean,
  location_count bigint,
  single_location_id uuid,
  total_count bigint
)
language sql
stable
set search_path = ''
as $$
  with rolled as (
    select
      v.id as variant_id,
      v.product_id,
      v.sku,
      v.title as variant_title,
      p.title as product_title,
      coalesce(sum(b.on_hand), 0)::bigint as on_hand,
      coalesce(sum(b.reserved), 0)::bigint as reserved,
      coalesce(sum(b.incoming), 0)::bigint as incoming,
      coalesce(sum(b.available), 0)::bigint as available,
      coalesce(bool_or(b.reorder_point is not null and b.available <= b.reorder_point), false) as low,
      count(b.location_id)::bigint as location_count,
      (case when count(b.location_id) = 1 then min(b.location_id::text)::uuid else null end) as single_location_id
    from public.variant_dim v
    join public.product_dim p on p.id = v.product_id
    left join public.inventory_balance b
      on b.variant_id = v.id and b.shop_id = p_shop_id
    where v.shop_id = p_shop_id
      and p.status <> 'archived'
      and coalesce(v.inventory_tracked, true)
      and (
        p_search is null or p_search = ''
        or v.sku ilike '%' || p_search || '%'
        or v.title ilike '%' || p_search || '%'
        or p.title ilike '%' || p_search || '%'
      )
    group by v.id, v.product_id, v.sku, v.title, p.title
  ),
  filtered as (
    select * from rolled
    where p_stock is null
       or (p_stock = 'out' and on_hand <= 0)
       or (p_stock = 'low' and (low or on_hand <= 0))
  )
  select f.*, count(*) over ()::bigint as total_count
  from filtered f
  order by f.on_hand asc, f.product_title asc, f.variant_id asc
  limit greatest(p_limit, 0) offset greatest(p_offset, 0)
$$;
```

  (Ordering: lowest stock first — the rows a merchant needs to act on. Do NOT apply this migration; the orchestrator applies it. Note it in your task report.)

- [ ] **Step 2: Failing test** for the pure mapper (the RPC itself can't be unit-tested here):

```ts
// app/lib/catalog/inventory-list.server.test.ts
import { describe, expect, it } from "vitest";
import { mapInventoryRow, restockKeyFromParams } from "./inventory-list.server";

describe("mapInventoryRow", () => {
  it("maps snake_case RPC output and null single_location_id", () => {
    const row = mapInventoryRow({
      variant_id: "v1", product_id: "p1", sku: "SKU-1", variant_title: "M / Red",
      product_title: "Tee", on_hand: 5, reserved: 2, incoming: 0, available: 3,
      low: true, location_count: 2, single_location_id: null, total_count: 41,
    });
    expect(row).toEqual({
      variantId: "v1", productId: "p1", sku: "SKU-1", variantTitle: "M / Red",
      productTitle: "Tee", onHand: 5, reserved: 2, incoming: 0, available: 3,
      low: true, locationCount: 2, singleLocationId: null, restock: null,
    });
  });
});

describe("restockKeyFromParams", () => {
  it("extracts the first PO line sku", () => {
    expect(restockKeyFromParams({ po: { lines: [{ sku: "SKU-1" }] } })).toBe("SKU-1");
  });
  it("returns null when the snapshot is absent or malformed", () => {
    expect(restockKeyFromParams(null)).toBeNull();
    expect(restockKeyFromParams({})).toBeNull();
    expect(restockKeyFromParams({ po: { lines: [] } })).toBeNull();
  });
});
```

- [ ] **Step 3: Run — FAIL. Step 4: Implement `inventory-list.server.ts`**: `listInventory` calls `getSupabase().rpc("inventory_list", { p_shop_id: shopId, p_search: opts.search ?? null, p_stock: opts.stock ?? null, p_limit: Math.min(opts.limit ?? 50, 100), p_offset: Math.max(0, opts.offset ?? 0) })`, maps rows with exported `mapInventoryRow`, total from first row's `total_count` (0 when empty). `attachRestockPresence`: one query `from("action_audit").select("id, params, outcome, created_at").eq("shop_id", shopId).eq("action_kind", "create_po_draft").gte("created_at", <now-30d ISO>).order("created_at", { ascending: false }).limit(200)`; build `Map<sku, {auditId, createdAt, outcome}>` keeping first (latest) per sku via exported `restockKeyFromParams(params: unknown): string | null`; decorate rows whose sku matches. **Step 5: Tests pass.**

- [ ] **Step 6: Route** `dashboard.api.catalog.inventory._index.tsx` — loader only: parse `search`, `stock` (only accept `"low"`/`"out"`), `offset`; `listInventory` then `attachRestockPresence`; return `{ rows, total }`. (Remix flat routes: `dashboard.api.catalog.inventory._index.tsx` serves GET `/dashboard/api/catalog/inventory` alongside the existing `$variantId` route — verify with `npx remix routes` if unsure.)

- [ ] **Step 7: Client**: `InventoryRowVM` + `fetchInventoryList` in client.ts inventory section. **Step 8: Verify + commit** `catalog/inventory: shop-wide inventory list RPC + endpoint`.

---

### Task 4: Inventory screen rework (search, filter, columns, inline qty, drawer, Autopilot presence)

**Files:**
- Modify: `app/components/dashboard/screens/Inventory.tsx` (full rework)
- Modify: `app/lib/dashboard/screen-cache.ts` (add `inventoryList: "inventory-list"` to SCREEN_CACHE_KEYS; keep `inventorySkus` — other code may still use it)
- Modify: `app/lib/dashboard/prefetch.ts` (WARM_TARGETS: replace the `inventorySkus`/`fetchSkus` pair with `[SCREEN_CACHE_KEYS.inventoryList, () => fetchInventoryList({})]`)
- Test: `app/components/dashboard/screens/__tests__/inventory-screen.test.tsx` (static render smoke)

**Interfaces:**
- Consumes: `fetchInventoryList`, `InventoryRowVM` (Task 3); `setOnHand(variantId, locationId, onHand)` (client.ts:1436); `InventoryPanel({ app, variantId })`; `app.navigate("product-editor", productId)`; `app.navigate("products-po")`.
- Produces: the reworked screen. No new exported APIs.

- [ ] **Step 1: Screen structure** (keep header + Card shell):
  - State: `rows: InventoryRowVM[] | null` seeded from `cachedScreenData(SCREEN_CACHE_KEYS.inventoryList)` (shape `{ rows, total }`), `total`, `search`+debounced `query` (300ms, Orders idiom), `stock: "all" | "low" | "out"` via `Segmented small`, `offset` implicit (`rows.length`), `loadingMore`, `error`, `openVariant: string | null` (drawer), `editing: { variantId: string; value: string } | null` (inline edit), `savingQty: string | null`.
  - Load effect on `[query, stock]`: default state (`!query && stock === "all"`) reads+writes the cache key; others live-only. Fetch replaces rows; `loadMore` appends with the same filter-token guard + id-dedupe idiom as Catalog.tsx:100-120.
  - Columns `GRID = "2fr 0.7fr 0.7fr 0.7fr 1fr 1.1fr"`: Product / On hand / Reserved / Available / Status / (Autopilot or actions). Product cell = productTitle + caption sku · variantTitle. Status: `Pill` — `onHand <= 0` → critical "Out of stock"; `low` → warn "Low"; else success "Healthy".
  - **Inline qty** (single-location rows only, `locationCount === 1 && singleLocationId`): the On hand cell renders an input (`className="cd-input tabular-nums"`, width 72) using the InventoryPanel remount-key idiom (`key={\`oh:${r.variantId}:${r.onHand}\`}`, `defaultValue={r.onHand}`, commit on blur AND on Enter via `e.currentTarget.blur()`); on commit if changed: optimistic `setRows` patch (onHand + available delta), `setOnHand(r.variantId, r.singleLocationId, next).catch(→ rollback to snapshot + toast)`. Multi-location rows show the number + caption `${locationCount} locations`; clicking anywhere on the row (except the input) opens the drawer.
  - **Autopilot presence**: when `r.restock` and (`low` or out): `<button className="cd-badge" onClick={() => app.navigate("products-po")}>` with `CDIcon name="doc"` + `Restock draft · {timeAgo(r.restock.createdAt)}` (import `timeAgo` from `../format`). When low/out and NO restock, keep the cell empty (don't fake agent activity).
  - **Drawer**: rendered when `openVariant`, using the TransferModal fixed-overlay idiom but right-anchored: outer `role="presentation"` fixed inset-0 with the same `color-mix` scrim, inner `role="dialog" aria-modal="true" aria-label="Stock details"` `style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: "min(560px, 100vw)", overflowY: "auto", padding: 16 }}` containing a `Card` with the product title header, `<InventoryPanel app={app} variantId={openVariant} />`, and a footer `Btn small icon="external"` "Open product" → `app.navigate("product-editor", productId)`. Escape closes (window keydown effect); scrim click closes. After close, re-run the current load so drawer edits reflect in the grid.
  - Empty/error/loading: `TableSkeleton` while first load with no seed; error → `Placeholder icon="warn"` with the message; empty-with-filters vs truly-empty copy split like Catalog.
- [ ] **Step 2: Smoke test** (static markup, `makeApp` factory pattern from `__tests__/import-shopify-auth-link.test.tsx`): renders header + skeleton when loading; renders an "Out of stock" pill and a "Restock draft" badge from a stubbed row list injected by mocking `fetchInventoryList` via `vi.mock("~/lib/dashboard/client", ...)` — follow the existing test file's mock style; static render exercises the seeded-cache path: pre-populate with `cacheScreenData(SCREEN_CACHE_KEYS.inventoryList, { rows: [...], total: 2 })` then assert markup contains "Out of stock" and "Restock draft".
- [ ] **Step 3: Icon check** — `doc`, `external`, `x`, `box` must exist in CD_ICONS; add any missing via lucide import + one CD_ICONS line.
- [ ] **Step 4: Verify + commit** `dashboard/Inventory: search, stock filter, balances columns, inline qty, drawer, restock presence`.

---

### Task 5: Purchase orders — dedicated fetch, honest PDF, cache

**Files:**
- Create: `app/routes/dashboard.api.catalog.purchase-orders.tsx`
- Create: `app/lib/catalog/po-list.server.ts`
- Modify: `app/lib/dashboard/client.ts` (fetchPurchaseOrders + VM)
- Modify: `app/lib/dashboard/screen-cache.ts` (+ `purchaseOrders: "purchase-orders"`), `app/lib/dashboard/prefetch.ts` (append WARM target)
- Modify: `app/components/dashboard/screens/PurchaseOrders.tsx`
- Test: `app/lib/catalog/po-list.server.test.ts`

**Interfaces:**
- Consumes: `action_audit` columns `id, action_kind, outcome, params, last_error, created_at`; `PoDraft` shape `{ po_number, lines: [{ sku, title, quantity, unit_cost_cents }], total_cents }` under `params.po` (app/lib/po/draft.server.ts).
- Produces: `mapPoRow(raw): PurchaseOrderRow` (pure, exported) → `{ id, poNumber: string | null, sku: string | null, lineCount: number, totalCents: number | null, outcome: string, createdAt: string, lastError: string | null, hasPdf: boolean }` with `hasPdf = action_kind === "create_po_draft" && params?.po != null` (the PDF route's exact 404 predicate). `listPurchaseOrders(shopId, { limit = 50, offset = 0 })` → `{ rows, total }` (`{ count: "exact" }` on the select). Client `PurchaseOrderVM` (same fields) + `fetchPurchaseOrders(opts)` → GET `/dashboard/api/catalog/purchase-orders?offset=`.

- [ ] **Step 1: Failing test** — `mapPoRow`: full snapshot row → all fields + `hasPdf: true`; `params: {}` → `hasPdf: false`, nulls, `lineCount: 0`; malformed `params.po.lines` (not an array) → `lineCount 0`, `totalCents` from `po.total_cents` only when a finite number. **Step 2: FAIL. Step 3: Implement** (select `.eq("action_kind", "create_po_draft")`, order created_at desc, range paging). **Step 4: pass.**
- [ ] **Step 5: Route** (loader only, parse offset) + client fn + cache key + WARM target `[SCREEN_CACHE_KEYS.purchaseOrders, () => fetchPurchaseOrders({})]`.
- [ ] **Step 6: Screen rework**: own fetch (seed/write-through cache on default offset 0), Load-more footer (Catalog idiom), framing copy under the h1: `"Restock drafts Calderyn created from inventory alerts. Each one snapshots a supplier-ready PO you can download."`; columns `PO / Detail / Drafted / Actions` where PO = `poNumber ?? id.slice(0,8).toUpperCase()`, Detail = `sku` + caption `${lineCount} line(s) · ${money(totalCents)}` when present, failed rows show `lastError` caption (friendly-trimmed to 80 chars); Download button ONLY when `row.hasPdf`. Keep OutcomeBadge. Empty state keeps the "View alerts" CTA.
- [ ] **Step 7: Verify + commit** `dashboard/PurchaseOrders: dedicated paginated fetch + honest PDF gating`.

---

### Task 6: Transfers — create from screen, received history, modal polish

**Files:**
- Modify: `app/routes/dashboard.api.catalog.inventory.transfer.tsx` (loader: `state` param)
- Modify: `app/lib/dashboard/transfers-client.ts` (+ fetchReceivedTransfers, receivedAt on VM)
- Modify: `app/components/dashboard/screens/Transfers.tsx`
- Modify: `app/components/dashboard/screens/TransferModal.tsx`
- Test: `app/components/dashboard/screens/__tests__/transfer-modal-state.test.ts` (pure picker/validation helpers — extract them)

**Interfaces:**
- Consumes: `fetchInventoryList` (Task 3) for the variant picker; `fetchVariantInventory` (client.ts:1430) for per-location availability; `SCREEN_CACHE_KEYS.locations` seed; `createTransfer`, `receiveTransfer`.
- Produces:
  - Loader accepts `?state=received&days=30`: `state` ∈ {`in_transit` (default), `received`}; received branch filters `.eq("state", "received").gte("received_at", <now - days,  clamp days to 1..90, default 30>)`, orders by `received_at desc`, limit 100, and each row gains `receivedAt: string | null`.
  - `ShopTransferVM` gains `receivedAt: string | null`; `fetchReceivedTransfers(): Promise<ShopTransferVM[]>`.
  - `TransferModal` props change to `{ app, variantId?: string | null, onClose, onDone }` — when `variantId` is absent it renders a picker step first (search input → `fetchInventoryList({ search })` debounced 300ms → click a row to select). Existing InventoryPanel call sites pass `variantId` and behave exactly as before.
  - Extracted pure helpers in TransferModal.tsx or a sibling `transfer-modal-state.ts`: `transferValidation(from, to, qty, availableAtSource: number | null): string | null` (message or null) — qty ≥ 1, from ≠ to, both set, and when `availableAtSource != null && qty > availableAtSource` → `"Only N available at the source location."`.

- [ ] **Step 1: Failing tests** for `transferValidation` (5 cases incl. the availability cap and null-availability passthrough). **Step 2-4: red → implement in `transfer-modal-state.ts` → green.**
- [ ] **Step 5: Loader + client** changes as specified (validate `state` strictly; unknown → 422 `invalid_state`).
- [ ] **Step 6: TransferModal**: seed locations from `cachedScreenData<LocationVM[]>(SCREEN_CACHE_KEYS.locations) ?? []` then revalidate; fetch failure → toast + inline `"Couldn't load locations."` caption (kill the silent catch). On `from` change with a chosen variant: `fetchVariantInventory(variant)` once (cache in state), show `Available at source: N` caption under the From select and clamp validation via `transferValidation`. Focus management: on mount focus the first focusable (picker input or From select) via a ref; trap Tab with a keydown handler cycling within the dialog (query `dialogRef.current.querySelectorAll('button, input, select')`). Picker step UI: search input + up to 8 result rows (`cd-row` buttons: productTitle / sku / available) + empty caption.
- [ ] **Step 7: Transfers screen**: header gains `Btn kind="primary" icon="swap"` "New transfer" → `<TransferModal app={app} onClose onDone={() => setReloadKey(k+1)} />`. Below the in-transit Card, a second `Card pad={false}` "Recently received" (last 30 days): fetch `fetchReceivedTransfers()` alongside pending (Promise.allSettled — one failing list must not blank the other; each renders its own error Placeholder), rows show sku/variant, qty, route, `Received {timeAgo(receivedAt)}` Pill tone success. Refetch-failure honesty: when a reload fails but stale rows exist, keep rows and render a thin inline warning row (`cd-caption`, warn color): `"Couldn't refresh just now — showing the last loaded list."` (state `staleWarning: boolean`). Empty in-transit state CTA becomes "New transfer" (opens the modal) instead of navigating to Inventory.
- [ ] **Step 8: Verify + commit** `dashboard/Transfers: create from screen, received history, modal availability + focus trap`.

---

### Task 7: Collections — full management + detail view

**Files:**
- Modify: `app/lib/catalog/catalog.server.ts` (listCollections + counts; + updateCollection, deleteCollection, listCollectionProducts, addProductToCollection, removeProductFromCollection)
- Modify: `app/routes/dashboard.api.catalog.collections.tsx` (GET gains counts — no contract break, additive)
- Create: `app/routes/dashboard.api.catalog.collections.$id.tsx` (PUT rename / DELETE)
- Create: `app/routes/dashboard.api.catalog.collections.$id.products.tsx` (GET / POST add / DELETE remove)
- Modify: `app/lib/dashboard/client.ts` (CollectionVM + fns)
- Modify: `app/components/dashboard/routes.ts` (collection-detail URL)
- Modify: `app/components/dashboard/screens/Collections.tsx` (list + detail split on `app.nav.param`)
- Test: extend the existing routes round-trip test if present (`grep -rl "parsePath" app/components/dashboard/**/__tests__ app/components/dashboard/*.test.*`); otherwise create `app/components/dashboard/__tests__/routes-collections.test.ts`

**Interfaces:**
- Consumes: `collection_dim` (id, shop_id, handle, title), `product_collection` (product_id, collection_id), `signMediaPaths` for member thumbnails (mirror listProducts' primary-media lookup, catalog.server.ts:61-66), CalderynError for 404s.
- Produces:
  - Server: `listCollections(shopId): Promise<Array<{ id; title; handle; productCount: number }>>` (counts via one `product_collection` select of `collection_id` `.in(ids)` + fold — NOT a per-collection query); `updateCollection(shopId, collectionId, title): Promise<void>` (handle unchanged — links stay stable); `deleteCollection(shopId, collectionId): Promise<void>` (delete memberships first, then the row); `listCollectionProducts(shopId, collectionId): Promise<Array<{ id; title; status; imageUrl-path...: string | null }>>` returning `primaryImagePath` for route-side signing; `addProductToCollection(shopId, collectionId, productId)` (ownership checks both sides, upsert ignoreDuplicates); `removeProductFromCollection(...)`.
  - Client: `CollectionVM` gains `productCount: number` (createCollection returns `productCount: 0`); `renameCollection(id, title)`, `deleteCollection(id)`, `fetchCollectionProducts(id): Promise<Array<{ id; title; status; imageUrl: string | null }>>`, `addToCollection(id, productId)`, `removeFromCollection(id, productId)`.
  - Routing: `seg()` case "collections" becomes `param ? \`products/collections/${encodeURIComponent(param)}\` : "products/collections"`; `parsePath` "products" branch: when `b === "collections"` allow ONE more segment — restructure the guard: currently `if (rest.length > 0) return null` sits above the switch; change it to allow exactly `a === "products" && b === "collections" && rest.length === 1` → `{ screen: "collections", param: rest[0], sub: null }` (decode already applied). Keep every other path shape rejected.

- [ ] **Step 1: Failing routes test**: `pathFor({ screen: "collections", param: "abc", sub: null })` → `/dashboard/products/collections/abc`; `parsePath` inverts it; `parsePath("/dashboard/products/collections/a/b")` → null; existing `products/collections` still → collections list. **Step 2-3: red → implement → green.**
- [ ] **Step 4: Server fns + routes.** Handlers: PUT body `{ title }` non-empty → `updateCollection` else 422 `missing_title`; DELETE → `deleteCollection` → `{ ok: true }`; membership GET signs thumbnails via `signMediaPaths`; POST/DELETE bodies `{ productId }` string else 422 `missing_product`. All writes `requireSameOrigin`. 404 via CalderynError(404, "collection_not_found") when the shop-scoped lookup misses.
- [ ] **Step 5: Client fns** as specified.
- [ ] **Step 6: Screen.** `Collections({ app })` branches: `app.nav.param` → `<CollectionDetail app={app} id={param} />` else the list.
  - List: add Products column (`GRID = "2fr 1fr 0.6fr auto"` — title/handle/count/actions); row click → `app.navigate("collections", c.id)`; per-row inline rename (pencil `Btn small icon="edit"` swaps the title cell to an input, Enter/blur commits via `renameCollection` with optimistic cache write-through + rollback on error) and delete (`Btn small icon="trash"`, `window.confirm(\`Delete "${c.title}"? Products stay; they just leave this collection.\`)`).
  - Detail: back button (`cd-back` idiom from ProductEditor.tsx:181-184) → `app.navigate("collections")`; header = collection title + count; member rows (thumb / title / status Pill / Remove btn); "Add products" section: search input → debounced `fetchProducts({ search })` (exclude ids already in the collection) → rows with Add buttons. Loading skeletons + error placeholders per fetch; all mutations toast on failure.
  - Icon check: `edit`, `trash` in CD_ICONS (add if missing).
- [ ] **Step 7: Verify + commit** `dashboard/Collections: counts, rename, delete, detail view with membership editing`.

---

### Task 8: Locations — create, deactivate, honest states, dirty-check saves

**Files:**
- Modify: `app/routes/dashboard.api.catalog.locations._index.tsx` (GET: address fields + `.eq("active", true)`; add POST create)
- Modify: `app/routes/dashboard.api.catalog.locations.$id.tsx` (PUT accepts `active: false` deactivation with stock guard)
- Modify: `app/lib/catalog/locations.server.ts` (createLocation, deactivateLocation with guard)
- Modify: `app/lib/dashboard/client.ts` (createLocation, deactivateLocation)
- Modify: `app/components/dashboard/screens/Locations.tsx`
- Test: `app/lib/catalog/locations.server.test.ts` (pure validation helper)

**Interfaces:**
- Consumes: `location_dim` (shop_id, name, active, priority, lat, lng, street1, street2, city, region, postal_code, country); `inventory_balance` (location_id, on_hand, reserved, incoming).
- Produces:
  - `validateNewLocation(raw: unknown): { ok: true; value: { name: string; priority: number } } | { ok: false; code: "missing_name" }` (pure, exported; name trimmed 1..120 chars; priority `Math.trunc(Number) || 0`).
  - `createLocation(shopId, { name, priority }): Promise<{ id }>` (insert `active: true`).
  - `deactivateLocation(shopId, locationId): Promise<void>` — first checks `inventory_balance` for the location `.or("on_hand.gt.0,reserved.gt.0,incoming.gt.0")` limit 1; a hit throws `CalderynError(409, "location_has_stock", "Move or zero out stock at this location first.")`; then `update({ active: false })` shop-scoped.
  - GET returns `street1, street2, city, region, postal_code → postalCode, country` too (LocationVM already has the optional fields — the route just wasn't selecting them).
  - Client: `createLocation(input: { name: string; priority?: number }): Promise<{ id: string }>`; `deactivateLocation(id): Promise<void>` (PUT `{ active: false }`).

- [ ] **Step 1-3: TDD `validateNewLocation`** (valid; blank name; 121-char name; non-numeric priority → 0).
- [ ] **Step 4: Routes + server fns.** `_index` action: POST only → validate → create → `{ id }`. `$id` PUT: if `body.active === false`, run `deactivateLocation` (other patch keys ignored in the same request) → `{ ok: true }`; 409 surfaces through dashboardJson's CalderynError mapping.
- [ ] **Step 5: Screen rework.**
  - Load: real `loading` state (skeleton) + `error` state (`Placeholder icon="warn"`) — kill `.catch(() => {})`; empty state only when the fetch actually succeeded with zero rows, with copy `"No locations yet. Add one to start tracking stock."` + inline add form.
  - Add form (header row): name input + `Btn kind="primary" icon="plus"` "Add location", Enter submits; on success append (write through cache) + toast.
  - Deactivate: per-row `Btn small icon="x"` "Deactivate" with `window.confirm`; 409 → toast the server message; success removes the row (+ cache write-through).
  - Dirty-check saves: switch every input to the InventoryPanel idiom — value-derived `key` (`key={\`prio:${l.id}:${l.priority}\`}`) + `defaultValue` + blur handler that compares against the current row value and only calls `save` on a real change; after a successful save, patch `rows` (and cache) so the derived keys stay truthful.
- [ ] **Step 6: Verify + commit** `dashboard/Locations: create, deactivate with stock guard, honest load states, dirty-check saves`.

---

### Task 9: Product editor — media management, compare-at, cost, tracked toggle, InventoryPanel fixes

**Files:**
- Create: `supabase/migrations/20260710121000_variant_compare_at_price.sql`
- Modify: `app/lib/catalog/types.ts` (VariantInput + ProductDetail variants + media already fine)
- Modify: `app/lib/catalog/validate.ts` (compareAt rules)
- Modify: `app/lib/catalog/catalog.server.ts` (insert/update/getProduct variant mappings)
- Modify: `app/lib/catalog/media.server.ts` (+ setPrimaryMedia, setMediaAlt, moveMedia)
- Modify: `app/routes/dashboard.api.catalog.media.tsx` (PUT intents)
- Modify: `app/routes/dashboard.api.catalog.products.$id.tsx` (loader already signs media — extend the mapped VM with alt/position; verify by reading it)
- Modify: `app/lib/dashboard/client.ts` (VariantDraft.compareAtPriceCents; ProductDetailVM.media gains `alt: string | null; position: number`; media intent fns)
- Modify: `app/components/dashboard/screens/ProductEditor.tsx`, `app/components/dashboard/screens/InventoryPanel.tsx`
- Modify: `app/routes/storefront.products.$handle.tsx` (+ the owned PDP price renderer it delegates to — locate with `grep -rn "retailPriceCents\|retail_price_cents" app/lib/storefront/ | head`) for strikethrough compare-at
- Test: extend `app/lib/catalog/validate.ts`'s existing test file (find via `ls app/lib/catalog/*.test.ts`); if none exists, create `app/lib/catalog/validate.compare-at.test.ts`

**Interfaces:**
- Consumes: everything read in recon — `product_media` already has `position int`, `alt text`, `is_primary bool`; `variant_dim` has `unit_cost_cents`, `inventory_tracked` end-to-end (`unitCostCents`/`inventoryTracked` in VariantInput/VariantDraft).
- Produces:
  - Migration: `alter table public.variant_dim add column if not exists compare_at_price_cents integer; alter table public.variant_dim add constraint variant_compare_at_nonneg check (compare_at_price_cents is null or compare_at_price_cents >= 0);` (orchestrator applies).
  - `VariantInput.compareAtPriceCents?: number`, `ProductDetail` variant `compareAtPriceCents: number | null`; validate: negative → `negative_compare_at`, > INT4_MAX → overflow branch (extend the existing INT4 check), finite-narrowing in the raw mapper (mirror line 34's idiom).
  - Media server fns (all shop-scoped through the owning product like deleteProductMedia):
    - `setPrimaryMedia(shopId, mediaId)` — demote all `is_primary` on the product, set this one.
    - `setMediaAlt(shopId, mediaId, alt: string | null)` (trim; empty → null; max 300 chars).
    - `moveMedia(shopId, mediaId, dir: "up" | "down")` — load the product's bucket-backed rows ordered by position, swap `position` with the neighbor (no-op at the edge).
  - Media route PUT: `{ mediaId, intent: "set_primary" } | { mediaId, intent: "set_alt", alt } | { mediaId, intent: "move", dir }` → `{ ok: true }`; unknown intent 422.
  - Client: `setPrimaryProductImage(mediaId)`, `setProductImageAlt(mediaId, alt)`, `moveProductImage(mediaId, dir)`; `ProductDetailVM["media"][number]` = `{ id, url, isPrimary, alt: string | null, position: number }`.

- [ ] **Step 1-3: TDD validate compareAt** (accepts undefined/0/positive; rejects negative with `negative_compare_at`; rejects > INT4_MAX). Red → implement (types + validate + server variant insert/update/getProduct mappings: `compare_at_price_cents: v.compareAtPriceCents ?? null` on write, `compareAtPriceCents: (v.compare_at_price_cents as number | null) ?? null` on read; the update path reconciles by id — apply to both created and updated variants) → green.
- [ ] **Step 4: Media server fns + route PUT + client fns.** Keep the multipart POST and JSON DELETE exactly as-is; PUT is JSON via `apiSend`.
- [ ] **Step 5: Editor UI.**
  - Variants card: after Price add `Compare-at ($)` and `Cost ($)` inputs (same `centsToDollars`/`dollarsToCents` idiom, widths 110) wired to `compareAtPriceCents`/`unitCostCents`; add a `Track inventory` checkbox per variant (`checked={v.inventoryTracked !== false}` → `setVariantField(i, { inventoryTracked: e.target.checked })`). The header row gains matching labels; keep the row horizontally scrollable on small screens by wrapping the card body in `<div className="cd-table-scroll">`.
  - Images card: each tile gains a control strip under it (width 96): `Make main` (hidden on the primary; calls `setPrimaryProductImage` then locally re-flags), up/down arrow buttons (`CDIcon name="chevronLeft"` rotated? NO — add `arrowUp`/`arrowDown` or reuse existing arrow icons if present in CD_ICONS; check first) calling `moveProductImage` then swapping locally by position, and an alt input (`placeholder="Alt text"`, blur-commit via `setProductImageAlt`, value-derived key idiom). Media state type becomes the extended VM; sort tiles by `position` before render. All handlers toast on error and roll back local state.
  - Storefront: in the PDP price render, when `compareAtPriceCents != null && compareAtPriceCents > retailPriceCents` render `<s>` original + current price (match the storefront's existing price formatting util; keep markup minimal and theme-neutral). The owned PDP data loader must select + expose the new column (find via the grep in Files).
- [ ] **Step 6: InventoryPanel fixes** (surgical):
  - Loading: replace the bare `"Loading stock…"` caption with `<TableSkeleton rows={2} />` if TableSkeleton accepts a row count (read ui.tsx; else keep the caption but add the skeleton class wrapper).
  - Post-write reload honesty: `reload()` currently flips `loadError` even when stale rows exist; change the catch to: if rows already rendered, keep them and `app.toast("Saved, but the numbers may be stale — reopen to refresh.", "warn")`; only set `loadError` when there are no rows to show.
  - Empty state: `"No stock locations yet."` gains a `Btn small` "Open locations" → `app.navigate("locations-settings")`.
  - History: show all fetched entries (the API already caps at 50) in a `maxHeight: 240, overflowY: "auto"` list instead of `.slice(0, 12)`.
- [ ] **Step 7: Verify + commit** `dashboard/ProductEditor: media controls, compare-at + cost + tracked, storefront strikethrough, InventoryPanel polish`.

---

### Task 10: New product flow — multi-photo

**Files:**
- Modify: `app/components/dashboard/screens/NewProductFlow.tsx` (photo state, lines ~235-345 + upload ~627-633 + input ~734-741 + every `photoUrl`/`photoFile` reference — grep within the file)
- Test: `app/components/dashboard/screens/__tests__/new-product-photos.test.ts` (pure helper)

**Interfaces:**
- Consumes: `PHOTO_TYPES`, `PHOTO_MAX_BYTES` consts (lines 43-44), `client.uploadProductImage`.
- Produces: `addPhotos(cur: PhotoDraft[], files: File[], max: number): { next: PhotoDraft[]; rejected: { name: string; reason: "type" | "size" | "limit" }[] }` where `type PhotoDraft = { file: File; url: string }` — pure, exported from a new sibling `new-product-photos.ts` module so it's testable without DOM File quirks (construct Files in the test via `new File([bytes], name, { type })`).

- [ ] **Step 1-3: TDD `addPhotos`**: accepts valid files up to `max = 8`; rejects wrong type / oversize / over-limit with reasons; preserves order. (In the pure module, take `makeUrl: (f: File) => string` as a parameter so tests can pass `() => "blob:x"` — `URL.createObjectURL` is passed in from the component.)
- [ ] **Step 4: Component rewire**: `photoFile/photoUrl` → `photos: PhotoDraft[]`; file input gains `multiple`; `onPickPhoto` → `onPickPhotos(FileList)` calling `addPhotos` (toast one summarized rejection message when any); previews render as a wrapping row of 72px tiles with per-tile remove (revoke that object URL); first tile badges "Main"; all existing single-photo UI copy adapts ("Add photos", "Swap photo" → "Add more"); unmount/replace revokes all URLs; readiness "Photo" badge = `photos.length > 0`. Save path: after `saveProduct` returns the id, upload sequentially in order (`for (const p of photos) await client.uploadProductImage(id, p.file)`) inside the existing try/catch — first upload is auto-primary server-side; on any failure toast `"Saved, but N photo(s) didn't upload — add them from the product editor."` and continue.
- [ ] **Step 5: Verify + commit** `dashboard/NewProductFlow: multi-photo create`.

---

### Task 11: Cross-cutting polish sweep + mobile pass

**Files:** every screen touched above + `app/styles/dashboard.css` (only additive utility rules if needed) + `app/components/dashboard/screens/NewProductFlow.tsx` (collections fetch catch — check for a silent catch and surface it like ProductEditor's `collectionsError`).

**No new interfaces.** This is a checklist task:

- [ ] Grep the products area for remaining silent catches: `grep -n "catch(() => {})" app/components/dashboard/screens/*.tsx app/lib/dashboard/*.ts` — each hit in Catalog/Inventory/Transfers/TransferModal/Collections/Locations/PurchaseOrders/ProductEditor/InventoryPanel/NewProductFlow must either surface (toast/inline) or carry a one-line comment justifying why silence is correct. Fix stragglers.
- [ ] Consistency pass: every list screen has skeleton-on-first-load, error Placeholder with the API message, distinct filtered-vs-truly-empty copy, and a footer count where paginated. Purchase orders + Transfers headers say "Products" with a sub line (existing pattern) — keep.
- [ ] Mobile pass at 390px width: tables with >4 columns get `overflow-x: auto` wrappers (`cd-table-scroll` exists — apply to Inventory grid + editor Variants card if not already); the Inventory drawer is full-width (`min(560px, 100vw)` — verify); bulk bar wraps (`flexWrap: "wrap"` — verify); TransferModal fits (maxWidth 420 ok).
- [ ] `npm run lint` on touched files with `--max-warnings=0`; fix everything.
- [ ] Commit `dashboard/products: cross-cutting polish + mobile pass`.

---

## Orchestrator-only steps (not subagent tasks)

1. Apply migrations after Tasks 3 and 9 land (supabase MCP, project `ajgrmnvzxfxxlwrxcgnu`), checking for slug-duplicate drift per the migration-drift landmine (compare by slug, verify object existence after).
2. After Task 11: full gate — `/code-review`, `git diff --check`, `npm run typecheck`, `npm run lint`, `npm run build`, `npx vitest run`.
3. Live browser e2e sweep of all sections (local dev recipe in memory `local-dashboard-dev-recipe`), fixing anything found.
4. Final self-review vs the spec; report to the user. No push / no PR without an explicit ask.
