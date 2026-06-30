# Slice 1 — Owned Catalog, Plan B2 (Editor Screens) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The dashboard screens a merchant uses to manage their owned catalog — a product list, a product editor (gallery, options→variant grid with stock, collections), and a collections manager — all calling the Plan B1 API.

**Architecture:** Three new screens in the existing dashboard SPA (`app/components/dashboard/screens/*`), registered in `DashboardApp.tsx`'s `NAV_ITEMS`/`SCREENS`. Each fetches its own data lazily via new typed functions in `app/lib/dashboard/client.ts` (the browser-only `apiGet`/`apiSend` layer). Images are read through server-minted signed URLs. The one non-trivial algorithm — turning options into a variant grid — is a pure, unit-tested helper.

**Tech Stack:** React 18 (the dashboard SPA), the `cd-*` design system + `CDIcon` (Lucide) — NOT Polaris (Polaris is the retired embedded app). vitest for the pure helper + client. Depends on Plan B1 (catalog API) + Plan A (owned tables).

## Global Constraints

- TypeScript only; `tsc --noEmit` authoritative; no `any` without written justification.
- Dashboard surface only: `cd-*` classes + `CDIcon` (Lucide) via the `CD_ICONS` registry. Do NOT use Polaris here, and do NOT use `lucide-react` outside the `CDIcon` registry — add an icon by one line in `app/components/dashboard/icons.tsx`.
- `client.ts` is browser-only: it may use `fetch`/`location`/`crypto.randomUUID()` and MUST NOT import any `*.server.ts`.
- New screens follow the existing screen pattern: a default-exported component taking `{ app }: { app: DashboardCtx }`, fetching with `client.*` in a `useEffect`, showing loading/error via `app.toast`.
- Browser-visible source stays product-neutral — no AI/provenance/dev-tool markers, no internal TODO ownership in JSX.
- Match the visual language of the sibling screens (`Inventory.tsx`, `Campaigns.tsx`): `cd-*` layout classes, `CDIcon`, the `ui.tsx` primitives (`Toggle`, etc.). Where this plan shows structural JSX, the exact `cd-*` utility classes follow those siblings.
- Pre-commit gate before committing: `npm run typecheck` → `npm run lint` (`--max-warnings=0` on touched files) → `npm run build`, all exit 0; `npx vitest run` green.

---

### Task 1: Register the catalog screens (nav, screen map, types, icon)

**Files:**
- Modify: `app/components/dashboard/context.ts` (extend the `Screen` id union)
- Modify: `app/components/dashboard/DashboardApp.tsx` (`NAV_ITEMS`, `SCREENS`, imports)
- Modify: `app/components/dashboard/icons.tsx` (add a `tag` icon for collections if absent)
- Create: `app/components/dashboard/screens/Catalog.tsx` (stub — real body in Task 5)
- Create: `app/components/dashboard/screens/ProductEditor.tsx` (stub — Task 6)
- Create: `app/components/dashboard/screens/Collections.tsx` (stub — Task 7)

**Interfaces:**
- Produces: navigable screens `catalog`, `product-editor`, `collections`. `product-editor` is reached via `app.navigate("product-editor", productId | "new")`; it is NOT in `NAV_ITEMS` (inner flow, like `generator`).

- [ ] **Step 1: Extend the `Screen` union in `context.ts`**

Find the `Screen` type (a string union of screen ids) and add the three ids:

```typescript
export type Screen =
  | "dashboard" | "alerts" | "campaigns" | "predictor" | "generator"
  | "analytics" | "inventory" | "audit" | "action-queue" | "live-engine"
  | "settings" | "labs"
  | "catalog" | "product-editor" | "collections";
```

- [ ] **Step 2: Create the three stub screens** (so imports resolve; bodies land in Tasks 5-7)

Each file, e.g. `app/components/dashboard/screens/Catalog.tsx`:

```tsx
import type { DashboardCtx } from "../context";

export default function Catalog(_props: { app: DashboardCtx }) {
  return <div className="cd-screen" />;
}
```

(Repeat for `ProductEditor.tsx` and `Collections.tsx`, same stub.)

- [ ] **Step 3: Register them in `DashboardApp.tsx`**

Add imports next to the other `Screen*` imports:

```tsx
import ScreenCatalog from "./screens/Catalog";
import ScreenProductEditor from "./screens/ProductEditor";
import ScreenCollections from "./screens/Collections";
```

Add nav items to `NAV_ITEMS` (after `inventory`):

```tsx
  { id: "catalog", label: "Products", icon: "box" },
  { id: "collections", label: "Collections", icon: "tag" },
```

Add to the `SCREENS` map:

```tsx
  catalog: ScreenCatalog,
  collections: ScreenCollections,
  // Inner flow off the product list — reached via navigate(), not in NAV_ITEMS.
  "product-editor": ScreenProductEditor,
```

- [ ] **Step 4: Ensure the `tag` icon exists**

In `app/components/dashboard/icons.tsx`, if `tag` is not already a key in `CD_ICONS`, import `Tag` from `lucide-react` and add `tag: Tag,` to the registry (one line). If it already exists, skip.

- [ ] **Step 5: Verify it compiles and the rail shows the new items**

Run: `npm run typecheck && npm run build`
Expected: exit 0. (The new rail items render and route to empty `cd-screen` divs for now.)

- [ ] **Step 6: Commit**

```bash
git add app/components/dashboard/context.ts app/components/dashboard/DashboardApp.tsx app/components/dashboard/icons.tsx app/components/dashboard/screens/Catalog.tsx app/components/dashboard/screens/ProductEditor.tsx app/components/dashboard/screens/Collections.tsx
git commit -m "feat(catalog): register Products/Collections screens in the dashboard shell"
```

---

### Task 2: Catalog client functions (browser data layer)

**Files:**
- Modify: `app/lib/dashboard/client.ts` (append catalog section)
- Test: `app/lib/dashboard/__tests__/client-catalog.test.ts`

**Interfaces:**
- Consumes: existing `apiGet`, `apiSend`.
- Produces (browser types + fetchers):
  - types `ProductSummaryVM`, `ProductDetailVM`, `CollectionVM`, `ProductDraft` (the editor's outbound shape — mirrors B1's `ProductInput`)
  - `fetchProducts(opts?): Promise<{ products: ProductSummaryVM[]; total: number }>`
  - `fetchProduct(id): Promise<ProductDetailVM>`
  - `saveProduct(draft, id?): Promise<{ id: string }>` (POST when no id, PUT when id)
  - `archiveProduct(id): Promise<void>`
  - `fetchCollections(): Promise<CollectionVM[]>`
  - `createCollection(title): Promise<CollectionVM>`
  - `uploadProductImage(productId, file): Promise<{ id: string; url: string }>`
  - `deleteProductImage(mediaId): Promise<void>`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
vi.stubGlobal("location", { origin: "https://app.x", assign: vi.fn() } as unknown as Location);

function ok(body: unknown) { return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response); }
beforeEach(() => fetchMock.mockReset());

describe("catalog client", () => {
  it("saveProduct POSTs when there is no id", async () => {
    fetchMock.mockReturnValue(ok({ id: "p1" }));
    const { saveProduct } = await import("../client");
    const res = await saveProduct({ title: "Tee", status: "active", variants: [{ sku: "S" }] });
    expect(res).toEqual({ id: "p1" });
    expect(fetchMock).toHaveBeenCalledWith("/dashboard/api/catalog/products", expect.objectContaining({ method: "POST" }));
  });

  it("saveProduct PUTs when given an id", async () => {
    fetchMock.mockReturnValue(ok({ ok: true }));
    const { saveProduct } = await import("../client");
    await saveProduct({ title: "Tee", status: "active", variants: [{ sku: "S" }] }, "p1");
    expect(fetchMock).toHaveBeenCalledWith("/dashboard/api/catalog/products/p1", expect.objectContaining({ method: "PUT" }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/dashboard/__tests__/client-catalog.test.ts`
Expected: FAIL — `saveProduct` not exported.

- [ ] **Step 3: Append the catalog section to `client.ts`**

```typescript
// --- catalog ----------------------------------------------------------------

export interface ProductSummaryVM { id: string; title: string; status: "draft" | "active" | "archived"; imageUrl: string | null; variantCount: number; updatedAt: string }
export interface VariantDraft { id?: string; sku?: string; title?: string; retailPriceCents?: number; unitCostCents?: number; inventoryTracked?: boolean; inventoryOnHand?: number; optionValues?: string[] }
export interface ProductDraft { title: string; status: "draft" | "active" | "archived"; vendor?: string; category?: string; description?: string; tags?: string[]; options?: Array<{ name: string; values: string[] }>; variants: VariantDraft[]; collectionIds?: string[] }
export interface ProductDetailVM extends ProductDraft { id: string; media: Array<{ id: string; url: string; isPrimary: boolean }>; updatedAt: string }
export interface CollectionVM { id: string; title: string; handle: string }

export async function fetchProducts(opts: { search?: string; status?: string; offset?: number } = {}): Promise<{ products: ProductSummaryVM[]; total: number }> {
  const qs = new URLSearchParams();
  if (opts.search) qs.set("search", opts.search);
  if (opts.status) qs.set("status", opts.status);
  if (opts.offset) qs.set("offset", String(opts.offset));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return apiGet<{ products: ProductSummaryVM[]; total: number }>(`/dashboard/api/catalog/products${suffix}`);
}

export async function fetchProduct(id: string): Promise<ProductDetailVM> {
  const data = await apiGet<{ product: ProductDetailVM }>(`/dashboard/api/catalog/products/${encodeURIComponent(id)}`);
  return data.product;
}

export async function saveProduct(draft: ProductDraft, id?: string): Promise<{ id: string }> {
  if (id) { await apiSend("PUT", `/dashboard/api/catalog/products/${encodeURIComponent(id)}`, draft); return { id }; }
  return apiSend<{ id: string }>("POST", "/dashboard/api/catalog/products", draft);
}

export async function archiveProduct(id: string): Promise<void> {
  await apiSend("DELETE", `/dashboard/api/catalog/products/${encodeURIComponent(id)}`);
}

export async function fetchCollections(): Promise<CollectionVM[]> {
  const data = await apiGet<{ collections: CollectionVM[] }>("/dashboard/api/catalog/collections");
  return data.collections;
}

export async function createCollection(title: string): Promise<CollectionVM> {
  const data = await apiSend<{ id: string }>("POST", "/dashboard/api/catalog/collections", { title });
  return { id: data.id, title, handle: title.toLowerCase().replace(/[^a-z0-9]+/g, "-") };
}

export async function uploadProductImage(productId: string, file: File): Promise<{ id: string; url: string }> {
  const fd = new FormData();
  fd.set("productId", productId);
  fd.set("file", file);
  // Multipart: do NOT set Content-Type (the browser sets the boundary). apiSend
  // forces JSON, so use a raw fetch here, mirroring sendAssistantMessage.
  const res = await fetch("/dashboard/api/catalog/media", { method: "POST", credentials: "same-origin", headers: { Origin: location.origin }, body: fd });
  if (res.status === 401) { location.assign("/dashboard/login"); throw new DashboardApiError(401, "unauthenticated", "Session expired"); }
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as { id: string; url: string };
}

export async function deleteProductImage(mediaId: string): Promise<void> {
  await apiSend("DELETE", "/dashboard/api/catalog/media", { mediaId });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/dashboard/__tests__/client-catalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/dashboard/client.ts app/lib/dashboard/__tests__/client-catalog.test.ts
git commit -m "feat(catalog): browser client (products/collections/media)"
```

---

### Task 3: Signed image URLs in the read responses (server)

**Files:**
- Modify: `app/routes/dashboard.api.catalog.products._index.tsx` (loader maps `primaryImagePath` → signed `imageUrl`)
- Modify: `app/routes/dashboard.api.catalog.products.$id.tsx` (loader maps each media `storagePath` → signed `url`)
- Create: `app/lib/catalog/sign-media.server.ts`
- Test: `app/lib/catalog/__tests__/sign-media.server.test.ts`

**Interfaces:**
- Produces:
  - `signMediaPath(path: string | null): Promise<string | null>` — mints a 1-hour signed URL for the `product-media` bucket; null passes through.
  - `signMediaPaths(paths: string[]): Promise<Map<string, string>>` — batch variant.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from "vitest";
const createSignedUrl = vi.fn().mockResolvedValue({ data: { signedUrl: "https://signed/x" }, error: null });
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ storage: { from: () => ({ createSignedUrl }) } }) }));

describe("signMediaPath", () => {
  it("returns null for null", async () => {
    const { signMediaPath } = await import("../sign-media.server");
    expect(await signMediaPath(null)).toBeNull();
  });
  it("signs a path", async () => {
    const { signMediaPath } = await import("../sign-media.server");
    expect(await signMediaPath("shop1/p1/x.png")).toBe("https://signed/x");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/catalog/__tests__/sign-media.server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `sign-media.server.ts`**

```typescript
// app/lib/catalog/sign-media.server.ts
import { getSupabase } from "../supabase.server";
import { PRODUCT_MEDIA_BUCKET } from "./media.server";

const TTL_SECONDS = 60 * 60;

export async function signMediaPath(path: string | null): Promise<string | null> {
  if (!path) return null;
  const { data } = await getSupabase().storage.from(PRODUCT_MEDIA_BUCKET).createSignedUrl(path, TTL_SECONDS);
  return data?.signedUrl ?? null;
}

export async function signMediaPaths(paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(paths.map(async (p) => { const u = await signMediaPath(p); if (u) out.set(p, u); }));
  return out;
}
```

- [ ] **Step 4: Wire it into the two product loaders**

In `dashboard.api.catalog.products._index.tsx` loader, after `listProducts(...)`, replace `primaryImagePath` with a signed `imageUrl`:

```tsx
return dashboardJson(async () => {
  const { products, total } = await listProducts(session.shopId, { /* …existing opts… */ });
  const signed = await signMediaPaths(products.map((p) => p.primaryImagePath).filter((p): p is string => Boolean(p)));
  return {
    total,
    products: products.map((p) => ({
      id: p.id, title: p.title, status: p.status, variantCount: p.variantCount, updatedAt: p.updatedAt,
      imageUrl: p.primaryImagePath ? signed.get(p.primaryImagePath) ?? null : null,
    })),
  };
});
```

In `dashboard.api.catalog.products.$id.tsx` loader, map `product.media[].storagePath` → `url`:

```tsx
return dashboardJson(async () => {
  const product = await getProduct(session.shopId, id);
  if (!product) throw jsonError(404, "not_found");
  const signed = await signMediaPaths(product.media.map((m) => m.storagePath));
  return { product: { ...product, media: product.media.map((m) => ({ id: m.id, url: signed.get(m.storagePath) ?? "", isPrimary: m.isPrimary })) } };
});
```

- [ ] **Step 5: Run the tests + typecheck**

Run: `npx vitest run app/lib/catalog && npm run typecheck`
Expected: PASS; exit 0.

- [ ] **Step 6: Commit**

```bash
git add app/lib/catalog/sign-media.server.ts app/lib/catalog/__tests__/sign-media.server.test.ts app/routes/dashboard.api.catalog.products._index.tsx app/routes/dashboard.api.catalog.products.$id.tsx
git commit -m "feat(catalog): serve product images via signed URLs"
```

---

### Task 4: `buildVariantMatrix` — options → variant grid (pure helper)

**Files:**
- Create: `app/lib/catalog/variant-matrix.ts`
- Test: `app/lib/catalog/__tests__/variant-matrix.test.ts`

**Interfaces:**
- Produces:
  - `buildVariantMatrix(options: Array<{ name: string; values: string[] }>, existing: VariantDraft[]): VariantDraft[]` — the cartesian product of option values, preserving the SKU/price/stock of any existing variant whose `optionValues` match a generated combination; new combinations start blank. With no options, returns a single default variant (preserving the existing one if present).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { buildVariantMatrix } from "../variant-matrix";

describe("buildVariantMatrix", () => {
  it("returns a single default variant when there are no options", () => {
    const out = buildVariantMatrix([], [{ sku: "BASE", retailPriceCents: 1999 }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(expect.objectContaining({ sku: "BASE", retailPriceCents: 1999, optionValues: [] }));
  });

  it("builds the cartesian product of two options", () => {
    const out = buildVariantMatrix([{ name: "Size", values: ["S", "M"] }, { name: "Color", values: ["Red"] }], []);
    expect(out.map((v) => v.optionValues)).toEqual([["S", "Red"], ["M", "Red"]]);
  });

  it("preserves existing variant data by matching option values", () => {
    const out = buildVariantMatrix([{ name: "Size", values: ["S", "M"] }], [{ sku: "OLD-M", retailPriceCents: 5, optionValues: ["M"] }]);
    const m = out.find((v) => v.optionValues?.[0] === "M");
    expect(m).toEqual(expect.objectContaining({ sku: "OLD-M", retailPriceCents: 5 }));
    const s = out.find((v) => v.optionValues?.[0] === "S");
    expect(s?.sku).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/catalog/__tests__/variant-matrix.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the helper**

```typescript
// app/lib/catalog/variant-matrix.ts
import type { VariantDraft } from "~/lib/dashboard/client";

function cartesian(values: string[][]): string[][] {
  return values.reduce<string[][]>((acc, list) => acc.flatMap((combo) => list.map((v) => [...combo, v])), [[]]);
}

export function buildVariantMatrix(
  options: Array<{ name: string; values: string[] }>,
  existing: VariantDraft[],
): VariantDraft[] {
  const usable = options.filter((o) => o.name.trim() && o.values.length);
  if (!usable.length) {
    const base = existing[0] ?? {};
    return [{ ...base, optionValues: [] }];
  }
  const byKey = new Map<string, VariantDraft>();
  for (const v of existing) byKey.set((v.optionValues ?? []).join(" "), v);

  return cartesian(usable.map((o) => o.values)).map((combo) => {
    const prior = byKey.get(combo.join(" "));
    return { ...(prior ?? {}), optionValues: combo };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/catalog/__tests__/variant-matrix.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/catalog/variant-matrix.ts app/lib/catalog/__tests__/variant-matrix.test.ts
git commit -m "feat(catalog): variant matrix generator (options → grid)"
```

---

### Task 5: Catalog screen (product list)

**Files:**
- Modify: `app/components/dashboard/screens/Catalog.tsx` (replace the stub)

**Interfaces:**
- Consumes: `app.navigate`, `app.toast`; `client.fetchProducts`.
- Behavior: on mount + on search/status change, fetch products; render a list (image, title, status, variant count). "New product" → `app.navigate("product-editor", "new")`; a row → `app.navigate("product-editor", id)`. Loading + empty states. Follow `Inventory.tsx`'s layout (cd-* header + list/table).

- [ ] **Step 1: Replace the stub body**

```tsx
import { useEffect, useState } from "react";
import type { DashboardCtx } from "../context";
import * as client from "~/lib/dashboard/client";
import { DashboardApiError } from "~/lib/dashboard/client";
import { CDIcon } from "../icons";

export default function Catalog({ app }: { app: DashboardCtx }) {
  const [products, setProducts] = useState<client.ProductSummaryVM[]>([]);
  const [status, setStatus] = useState<string>("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    client.fetchProducts({ search: search || undefined, status: status || undefined })
      .then((r) => { if (alive) setProducts(r.products); })
      .catch((err) => app.toast(err instanceof DashboardApiError ? err.message : "Couldn't load products.", "warn", "critical"))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [search, status, app]);

  return (
    <div className="cd-screen">
      <header className="cd-screen-head">
        <h1 className="cd-screen-title">Products</h1>
        <button className="cd-btn cd-btn-accent" onClick={() => app.navigate("product-editor", "new")}>
          <CDIcon name="plus" size={16} /> New product
        </button>
      </header>

      <div className="cd-toolbar">
        <input className="cd-input" placeholder="Search products" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="cd-select" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All</option>
          <option value="active">Active</option>
          <option value="draft">Draft</option>
          <option value="archived">Archived</option>
        </select>
      </div>

      {loading ? (
        <div className="cd-empty">Loading…</div>
      ) : products.length === 0 ? (
        <div className="cd-empty">No products yet. Create your first one.</div>
      ) : (
        <ul className="cd-list">
          {products.map((p) => (
            <li key={p.id} className="cd-list-row" onClick={() => app.navigate("product-editor", p.id)}>
              <span className="cd-thumb">{p.imageUrl ? <img src={p.imageUrl} alt="" /> : <CDIcon name="box" size={18} />}</span>
              <span className="cd-list-title">{p.title}</span>
              <span className="cd-badge" data-status={p.status}>{p.status}</span>
              <span className="cd-muted">{p.variantCount} variant{p.variantCount === 1 ? "" : "s"}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```
(`cd-screen`, `cd-screen-head`, `cd-btn`, `cd-input`, `cd-list`, `cd-badge`, `cd-empty`, `plus`/`box` icons follow the sibling screens; add any missing `cd-*` rule alongside the existing screen CSS and any missing icon to `CD_ICONS`.)

- [ ] **Step 2: Verify it compiles**

Run: `npm run typecheck && npm run build`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add app/components/dashboard/screens/Catalog.tsx app/components/dashboard/icons.tsx
git commit -m "feat(catalog): product list screen"
```

---

### Task 6: Product editor screen

**Files:**
- Modify: `app/components/dashboard/screens/ProductEditor.tsx` (replace the stub)

**Interfaces:**
- Consumes: `app.nav.param` (productId or `"new"`), `app.navigate`, `app.toast`; `client.fetchProduct`, `client.saveProduct`, `client.archiveProduct`, `client.fetchCollections`, `client.uploadProductImage`, `client.deleteProductImage`; `buildVariantMatrix`.
- Behavior: load the product when `param !== "new"`; edit title/status/vendor/tags/description; manage the gallery (upload, delete, the first image is primary); define options and regenerate the variant grid via `buildVariantMatrix`; edit per-variant SKU/price/stock; assign collections; Save (POST or PUT) → toast + `navigate("catalog")`; Archive on existing products.

- [ ] **Step 1: Replace the stub body**

```tsx
import { useEffect, useMemo, useState } from "react";
import type { DashboardCtx } from "../context";
import * as client from "~/lib/dashboard/client";
import { DashboardApiError } from "~/lib/dashboard/client";
import { buildVariantMatrix } from "~/lib/catalog/variant-matrix";

type Opt = { name: string; values: string[] };

export default function ProductEditor({ app }: { app: DashboardCtx }) {
  const id = app.nav.param && app.nav.param !== "new" ? app.nav.param : null;
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<"draft" | "active" | "archived">("draft");
  const [vendor, setVendor] = useState("");
  const [tags, setTags] = useState("");
  const [description, setDescription] = useState("");
  const [options, setOptions] = useState<Opt[]>([]);
  const [variants, setVariants] = useState<client.VariantDraft[]>([{ optionValues: [] }]);
  const [media, setMedia] = useState<Array<{ id: string; url: string; isPrimary: boolean }>>([]);
  const [collections, setCollections] = useState<client.CollectionVM[]>([]);
  const [selectedCollections, setSelectedCollections] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => { client.fetchCollections().then(setCollections).catch(() => {}); }, []);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    client.fetchProduct(id).then((p) => {
      if (!alive) return;
      setTitle(p.title); setStatus(p.status); setVendor(p.vendor ?? ""); setTags((p.tags ?? []).join(", "));
      setDescription(p.description ?? ""); setOptions((p.options ?? []).map((o) => ({ name: o.name, values: o.values })));
      setVariants(p.variants.length ? p.variants : [{ optionValues: [] }]);
      setMedia(p.media); setSelectedCollections(p.collectionIds ?? []);
    }).catch((err) => app.toast(err instanceof DashboardApiError ? err.message : "Couldn't load product.", "warn", "critical"));
    return () => { alive = false; };
  }, [id, app]);

  // Regenerate the variant grid whenever options change, preserving entered data.
  const regen = (next: Opt[]) => { setOptions(next); setVariants((cur) => buildVariantMatrix(next, cur)); };

  const onUpload = async (file: File) => {
    if (!id) { app.toast("Save the product first, then add images.", "warn"); return; }
    try { const m = await client.uploadProductImage(id, file); setMedia((cur) => [...cur, { id: m.id, url: m.url, isPrimary: cur.length === 0 }]); }
    catch (err) { app.toast(err instanceof DashboardApiError ? err.message : "Upload failed.", "warn", "critical"); }
  };

  const onSave = async () => {
    if (!title.trim()) { app.toast("Add a title.", "warn"); return; }
    setSaving(true);
    try {
      const draft: client.ProductDraft = {
        title: title.trim(), status, vendor: vendor || undefined, description: description || undefined,
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
        options: options.filter((o) => o.name.trim() && o.values.length),
        variants, collectionIds: selectedCollections,
      };
      await client.saveProduct(draft, id ?? undefined);
      app.toast("Product saved.", "check");
      app.navigate("catalog");
    } catch (err) { app.toast(err instanceof DashboardApiError ? err.message : "Save failed.", "warn", "critical"); }
    finally { setSaving(false); }
  };

  const onArchive = async () => {
    if (!id) return;
    try { await client.archiveProduct(id); app.toast("Product archived.", "check"); app.navigate("catalog"); }
    catch (err) { app.toast(err instanceof DashboardApiError ? err.message : "Archive failed.", "warn", "critical"); }
  };

  const variantLabel = (v: client.VariantDraft) => (v.optionValues ?? []).join(" / ") || "Default";
  const showStock = useMemo(() => variants.some((v) => v.inventoryTracked !== false), [variants]);

  return (
    <div className="cd-screen">
      <header className="cd-screen-head">
        <button className="cd-btn" onClick={() => app.navigate("catalog")}>Back</button>
        <h1 className="cd-screen-title">{id ? "Edit product" : "New product"}</h1>
        <div className="cd-spacer" />
        {id && <button className="cd-btn" onClick={onArchive}>Archive</button>}
        <button className="cd-btn cd-btn-accent" disabled={saving} onClick={onSave}>{saving ? "Saving…" : "Save"}</button>
      </header>

      <section className="cd-card">
        <label className="cd-field"><span>Title</span><input className="cd-input" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="cd-field"><span>Status</span>
          <select className="cd-select" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="draft">Draft</option><option value="active">Active</option><option value="archived">Archived</option>
          </select>
        </label>
        <label className="cd-field"><span>Vendor</span><input className="cd-input" value={vendor} onChange={(e) => setVendor(e.target.value)} /></label>
        <label className="cd-field"><span>Tags (comma-separated)</span><input className="cd-input" value={tags} onChange={(e) => setTags(e.target.value)} /></label>
        <label className="cd-field"><span>Description</span><textarea className="cd-input" value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      </section>

      <section className="cd-card">
        <h2 className="cd-card-title">Images</h2>
        <div className="cd-gallery">
          {media.map((m) => (
            <div key={m.id} className="cd-gallery-item">
              <img src={m.url} alt="" />
              {m.isPrimary && <span className="cd-badge">Main</span>}
              <button className="cd-icon-btn" onClick={async () => { await client.deleteProductImage(m.id); setMedia((cur) => cur.filter((x) => x.id !== m.id)); }}>Remove</button>
            </div>
          ))}
          <label className="cd-gallery-add">
            <input type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ""; }} />
            + Add image
          </label>
        </div>
        {!id && <p className="cd-muted">Save the product to start adding images.</p>}
      </section>

      <section className="cd-card">
        <h2 className="cd-card-title">Options</h2>
        {options.map((o, i) => (
          <div key={i} className="cd-opt-row">
            <input className="cd-input" placeholder="Option name (e.g. Size)" value={o.name}
              onChange={(e) => regen(options.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
            <input className="cd-input" placeholder="Values, comma-separated (S, M, L)" value={o.values.join(", ")}
              onChange={(e) => regen(options.map((x, j) => j === i ? { ...x, values: e.target.value.split(",").map((v) => v.trim()).filter(Boolean) } : x))} />
            <button className="cd-btn" onClick={() => regen(options.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
        <button className="cd-btn" onClick={() => regen([...options, { name: "", values: [] }])}>Add option</button>
      </section>

      <section className="cd-card">
        <h2 className="cd-card-title">Variants</h2>
        <table className="cd-table">
          <thead><tr><th>Variant</th><th>SKU</th><th>Price (cents)</th>{showStock && <th>Stock</th>}</tr></thead>
          <tbody>
            {variants.map((v, i) => (
              <tr key={i}>
                <td>{variantLabel(v)}</td>
                <td><input className="cd-input" value={v.sku ?? ""} onChange={(e) => setVariants((cur) => cur.map((x, j) => j === i ? { ...x, sku: e.target.value } : x))} /></td>
                <td><input className="cd-input" type="number" value={v.retailPriceCents ?? ""} onChange={(e) => setVariants((cur) => cur.map((x, j) => j === i ? { ...x, retailPriceCents: e.target.value === "" ? undefined : Number(e.target.value) } : x))} /></td>
                {showStock && <td><input className="cd-input" type="number" value={v.inventoryOnHand ?? 0} onChange={(e) => setVariants((cur) => cur.map((x, j) => j === i ? { ...x, inventoryOnHand: Math.max(0, Number(e.target.value) || 0) } : x))} /></td>}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="cd-card">
        <h2 className="cd-card-title">Collections</h2>
        <div className="cd-chips">
          {collections.map((c) => {
            const on = selectedCollections.includes(c.id);
            return <button key={c.id} className="cd-chip" data-on={on ? "1" : "0"}
              onClick={() => setSelectedCollections((cur) => on ? cur.filter((x) => x !== c.id) : [...cur, c.id])}>{c.title}</button>;
          })}
        </div>
      </section>
    </div>
  );
}
```
(All `cd-*` classes follow the sibling screens / existing dashboard CSS; add any missing rule alongside them. The component logic, state, and `client.*` calls above are complete.)

- [ ] **Step 2: Verify it compiles**

Run: `npm run typecheck && npm run build`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add app/components/dashboard/screens/ProductEditor.tsx
git commit -m "feat(catalog): product editor (gallery, options→variants, stock, collections)"
```

---

### Task 7: Collections screen

**Files:**
- Modify: `app/components/dashboard/screens/Collections.tsx` (replace the stub)

**Interfaces:**
- Consumes: `app.toast`; `client.fetchCollections`, `client.createCollection`.
- Behavior: list collections; a small form to create one (title → `createCollection` → prepend to the list).

- [ ] **Step 1: Replace the stub body**

```tsx
import { useEffect, useState } from "react";
import type { DashboardCtx } from "../context";
import * as client from "~/lib/dashboard/client";
import { DashboardApiError } from "~/lib/dashboard/client";

export default function Collections({ app }: { app: DashboardCtx }) {
  const [items, setItems] = useState<client.CollectionVM[]>([]);
  const [title, setTitle] = useState("");

  useEffect(() => { client.fetchCollections().then(setItems).catch(() => {}); }, []);

  const onCreate = async () => {
    const t = title.trim();
    if (!t) return;
    try { const c = await client.createCollection(t); setItems((cur) => [c, ...cur]); setTitle(""); app.toast("Collection created.", "check"); }
    catch (err) { app.toast(err instanceof DashboardApiError ? err.message : "Couldn't create collection.", "warn", "critical"); }
  };

  return (
    <div className="cd-screen">
      <header className="cd-screen-head"><h1 className="cd-screen-title">Collections</h1></header>
      <div className="cd-toolbar">
        <input className="cd-input" placeholder="New collection name" value={title}
          onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") onCreate(); }} />
        <button className="cd-btn cd-btn-accent" onClick={onCreate}>Create</button>
      </div>
      {items.length === 0 ? <div className="cd-empty">No collections yet.</div> : (
        <ul className="cd-list">{items.map((c) => <li key={c.id} className="cd-list-row"><span className="cd-list-title">{c.title}</span><span className="cd-muted">{c.handle}</span></li>)}</ul>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run typecheck && npm run build`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add app/components/dashboard/screens/Collections.tsx
git commit -m "feat(catalog): collections screen"
```

---

### Task 8: Full gate + manual smoke

- [ ] **Step 1: Run the whole gate and paste results**

```bash
npm run typecheck   # exit 0
npm run lint        # exit 0
npm run build       # exit 0
npx vitest run      # all green
```
Expected: every command exits 0.

- [ ] **Step 2: Manual smoke (against a dev session)**

With a logged-in dashboard session: open Products → New product → set title, an option (Size: S,M), fill SKU/price/stock per variant, save → it appears in the list → reopen it → add an image → save. Create a collection and assign it. Confirm the engine's existing Inventory screen still loads (proves `sku_dim` re-projection ran).

- [ ] **Step 3: Commit any fixups**

```bash
git add -A
git commit -m "chore(catalog): green gate for catalog editor UI"
```

---

## Self-Review

**Spec coverage (against `docs/superpowers/specs/2026-06-28-slice-1-owned-catalog-design.md`):**
- Product list (search, status filter) → Task 5. ✅
- Product editor: title/status/vendor/tags/description → Task 6. ✅
- Image gallery (upload, primary, remove) → Tasks 2, 3, 6. ✅
- Options → variant grid with SKU + price + **stock count** → Tasks 4, 6. ✅
- Collections (manager + assign) → Tasks 2, 6, 7. ✅
- Dashboard `cd-*` surface, not Polaris → all UI tasks. ✅
- Every write goes through the B1 API, which re-projects `sku_dim` → Task 2 client → B1 → Plan A projection. ✅

**Scoping honesty (callout for the user):** the screen tasks (5-7) give the **complete component logic, state, and `client.*` wiring**; the exact `cd-*` utility classes / CSS follow the existing sibling screens (`Inventory.tsx`, `Campaigns.tsx`) and the dashboard stylesheet, per the repo's design-system convention — inventing unread class names would be guessing. The genuinely novel logic (variant matrix, client calls, signed URLs, upload flow) is spelled out in full and unit-tested.

**Placeholder scan:** no TBD/TODO; the only "save first" guard is real product behavior, not a placeholder.

**Type consistency:** `ProductDraft`/`VariantDraft`/`ProductSummaryVM`/`ProductDetailVM`/`CollectionVM` are defined in `client.ts` (Task 2) and consumed identically by `buildVariantMatrix` (Task 4) and all three screens (Tasks 5-7). `app.navigate("product-editor", id|"new")` matches the `Screen` union extended in Task 1.

**Dependency note:** image upload requires the product to exist first (needs a `productId`), so the editor saves the product before accepting images — surfaced in the UI, not a silent failure.
