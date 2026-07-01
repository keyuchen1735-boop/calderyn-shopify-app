# Slice 1 — Owned Catalog, Plan B1 (Catalog API) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working dashboard catalog backend — list/read/create/update/archive products (with variants, options, media, collections) and upload images — every write landing in the owned tables and re-projected into `sku_dim`, ready for the editor UI (Plan B2) to call.

**Architecture:** A `catalog.server.ts` data layer keyed on the internal `shop_id` writes the owned tables (Plan A) and calls `projectProductToSkuDim` after every mutation so the engine's `sku_dim` stays current. Thin `dashboard.api.catalog.*` Remix routes wrap it with the established `requireDashboardSession` + `requireSameOrigin` + `dashboardJson` envelope. Images go to a private `product-media` Supabase Storage bucket.

**Tech Stack:** Remix routes, `@supabase/supabase-js` service-role client, Supabase Storage, vitest. Depends on Plan A (owned tables + `projectProductToSkuDim`).

## Global Constraints

- TypeScript only; `tsc --noEmit` authoritative; no `any` without written justification — shape DTOs at the action boundary, never trust `FormData`/JSON shape.
- Loaders read-only; mutations in actions; actions return through `dashboardJson` (or `jsonError`). State-changing routes call `requireSameOrigin(request)` first (CSRF guard).
- Every catalog endpoint authenticates with `requireDashboardSession(request)` and scopes by `session.shopId` (NOT `shopDomain` — owned shops may have none).
- After ANY catalog mutation, call `projectProductToSkuDim(productId)` (Plan A) so `sku_dim` and the engine stay correct. This is non-optional — a write that skips it silently desyncs the brain.
- New tables already have RLS-on/no-policy (Plan A); access is service-role via `getSupabase()`.
- Pre-commit gate before committing: `npm run typecheck` → `npm run lint` (`--max-warnings=0` on touched files) → `npm run build`, all exit 0; `npx vitest run` green.

### Shared types (defined once, consumed by routes + Plan B2)

```typescript
// app/lib/catalog/types.ts
export type ProductStatus = "draft" | "active" | "archived";

export interface OptionInput { name: string; values: string[] }
export interface VariantInput {
  id?: string;                 // present when editing an existing variant
  sku?: string;
  title?: string;
  retailPriceCents?: number;
  unitCostCents?: number;
  inventoryPolicy?: string;
  inventoryTracked?: boolean;
  inventoryOnHand?: number;
  optionValues?: string[];     // option-value labels this variant represents, e.g. ["M","Red"]
}
export interface ProductInput {
  title: string;
  status: ProductStatus;
  vendor?: string;
  category?: string;
  description?: string;
  tags?: string[];
  options?: OptionInput[];
  variants: VariantInput[];
  collectionIds?: string[];
}
export interface ProductSummary {
  id: string;
  title: string;
  status: ProductStatus;
  primaryImagePath: string | null;
  variantCount: number;
  updatedAt: string;
}
```

---

### Task 1: Storage bucket for product images

**Files:**
- Create: `supabase/migrations/20260628140000_product_media_bucket.sql`
- Create: `tests/engine/schema/migrations/20260628140000_product_media_bucket.sql` (identical copy)

**Interfaces:**
- Produces: a private Storage bucket `product-media`.

- [ ] **Step 1: Write the migration**

```sql
-- Private bucket for owned-catalog product images (Slice 1). Service-role writes
-- via getSupabase(); reads are served through signed URLs minted server-side.
insert into storage.buckets (id, name, public)
values ('product-media', 'product-media', false)
on conflict (id) do nothing;
```

- [ ] **Step 2: Apply via the Supabase MCP and verify**

Apply with `apply_migration` (project `ajgrmnvzxfxxlwrxcgnu`, name `product_media_bucket`), then verify with `execute_sql`:
```sql
select id, public from storage.buckets where id = 'product-media';
```
Expected: one row, `public = f`. (The `storage` schema only exists on the real Supabase project, which is where this bucket migration is applied.)

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260628140000_product_media_bucket.sql tests/engine/schema/migrations/20260628140000_product_media_bucket.sql
git commit -m "feat(catalog): private product-media storage bucket"
```

---

### Task 2: Catalog read layer — list + get

**Files:**
- Create: `app/lib/catalog/types.ts` (the shared types above)
- Create: `app/lib/catalog/catalog.server.ts`
- Test: `app/lib/catalog/__tests__/catalog-read.server.test.ts`

**Interfaces:**
- Consumes: `getSupabase` (`app/lib/supabase.server.ts`).
- Produces:
  - `listProducts(shopId: string, opts?: { search?: string; status?: ProductStatus; limit?: number; offset?: number }): Promise<{ products: ProductSummary[]; total: number }>`
  - `getProduct(shopId: string, productId: string): Promise<ProductDetail | null>` where `ProductDetail` = the product row + `options[]` (with values), `variants[]` (with `optionValues[]`), `media[]`, `collectionIds[]`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const productsQuery = { data: [{ id: "p1", title: "Tee", status: "active", updated_at: "2026-06-28T00:00:00Z" }], count: 1, error: null };
const mediaQuery = { data: [{ product_id: "p1", storage_path: "a.jpg" }], error: null };
const variantCountQuery = { data: [{ product_id: "p1" }, { product_id: "p1" }], error: null };

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: (table: string) => {
      if (table === "product_dim") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({ range: () => Promise.resolve(productsQuery) }),
            }),
          }),
        };
      }
      if (table === "product_media") {
        return { select: () => ({ in: () => ({ eq: () => Promise.resolve(mediaQuery) }) }) };
      }
      // variant_dim
      return { select: () => ({ in: () => Promise.resolve(variantCountQuery) }) };
    },
  }),
}));

beforeEach(() => {});

describe("listProducts", () => {
  it("returns summaries with primary image + variant count", async () => {
    const { listProducts } = await import("../catalog.server");
    const { products, total } = await listProducts("shop1", {});
    expect(total).toBe(1);
    expect(products[0]).toEqual(expect.objectContaining({ id: "p1", variantCount: 2, primaryImagePath: "a.jpg" }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/catalog/__tests__/catalog-read.server.test.ts`
Expected: FAIL — cannot find module `../catalog.server`.

- [ ] **Step 3: Write `types.ts` and the read functions**

Create `app/lib/catalog/types.ts` with the "Shared types" block above, plus:

```typescript
export interface ProductDetail {
  id: string;
  title: string;
  status: ProductStatus;
  vendor: string | null;
  category: string | null;
  description: string | null;
  tags: string[];
  options: Array<{ id: string; name: string; values: Array<{ id: string; value: string }> }>;
  variants: Array<{
    id: string; sku: string | null; title: string; retailPriceCents: number | null;
    unitCostCents: number | null; inventoryTracked: boolean | null; inventoryOnHand: number;
    optionValueIds: string[];
  }>;
  media: Array<{ id: string; storagePath: string; alt: string | null; position: number; isPrimary: boolean }>;
  collectionIds: string[];
  updatedAt: string;
}
```

Create `app/lib/catalog/catalog.server.ts`:

```typescript
import { getSupabase } from "../supabase.server";
import type { ProductStatus, ProductSummary, ProductDetail } from "./types";

export async function listProducts(
  shopId: string,
  opts: { search?: string; status?: ProductStatus; limit?: number; offset?: number } = {},
): Promise<{ products: ProductSummary[]; total: number }> {
  const sb = getSupabase();
  const limit = Math.min(opts.limit ?? 50, 100);
  const offset = opts.offset ?? 0;

  let q = sb
    .from("product_dim")
    .select("id, title, status, updated_at", { count: "exact" })
    .eq("shop_id", shopId);
  if (opts.status) q = q.eq("status", opts.status);
  if (opts.search) q = q.ilike("title", `%${opts.search}%`);
  const { data: rows, count, error } = await q.order("updated_at", { ascending: false }).range(offset, offset + limit - 1);
  if (error) throw error;

  const ids = (rows ?? []).map((r: { id: string }) => r.id);
  const mediaByProduct = new Map<string, string>();
  const variantCount = new Map<string, number>();
  if (ids.length) {
    const { data: media } = await sb.from("product_media").select("product_id, storage_path").in("product_id", ids).eq("is_primary", true);
    for (const m of media ?? []) mediaByProduct.set(String(m.product_id), String(m.storage_path));
    const { data: variants } = await sb.from("variant_dim").select("product_id").in("product_id", ids);
    for (const v of variants ?? []) variantCount.set(String(v.product_id), (variantCount.get(String(v.product_id)) ?? 0) + 1);
  }

  const products: ProductSummary[] = (rows ?? []).map((r: Record<string, unknown>) => ({
    id: String(r.id),
    title: String(r.title),
    status: r.status as ProductStatus,
    primaryImagePath: mediaByProduct.get(String(r.id)) ?? null,
    variantCount: variantCount.get(String(r.id)) ?? 0,
    updatedAt: String(r.updated_at),
  }));
  return { products, total: count ?? products.length };
}

export async function getProduct(shopId: string, productId: string): Promise<ProductDetail | null> {
  const sb = getSupabase();
  const { data: p, error } = await sb
    .from("product_dim")
    .select("id, title, status, vendor, category, description, tags, updated_at")
    .eq("shop_id", shopId)
    .eq("id", productId)
    .maybeSingle();
  if (error) throw error;
  if (!p) return null;

  const [{ data: options }, { data: variants }, { data: vov }, { data: media }, { data: pc }] = await Promise.all([
    sb.from("product_option").select("id, name, position, product_option_value(id, value, position)").eq("product_id", productId).order("position"),
    sb.from("variant_dim").select("id, sku, title, retail_price_cents, unit_cost_cents, inventory_tracked, inventory_on_hand, position").eq("product_id", productId).order("position"),
    sb.from("variant_option_value").select("variant_id, option_value_id"),
    sb.from("product_media").select("id, storage_path, alt, position, is_primary").eq("product_id", productId).order("position"),
    sb.from("product_collection").select("collection_id").eq("product_id", productId),
  ]);

  const valuesByVariant = new Map<string, string[]>();
  for (const row of vov ?? []) {
    const k = String(row.variant_id);
    valuesByVariant.set(k, [...(valuesByVariant.get(k) ?? []), String(row.option_value_id)]);
  }

  return {
    id: String(p.id),
    title: String(p.title),
    status: p.status as ProductStatus,
    vendor: p.vendor ?? null,
    category: p.category ?? null,
    description: p.description ?? null,
    tags: (p.tags as string[]) ?? [],
    options: (options ?? []).map((o: Record<string, unknown>) => ({
      id: String(o.id),
      name: String(o.name),
      values: ((o.product_option_value as Array<{ id: string; value: string }>) ?? []).map((v) => ({ id: String(v.id), value: String(v.value) })),
    })),
    variants: (variants ?? []).map((v: Record<string, unknown>) => ({
      id: String(v.id),
      sku: (v.sku as string | null) ?? null,
      title: String(v.title),
      retailPriceCents: (v.retail_price_cents as number | null) ?? null,
      unitCostCents: (v.unit_cost_cents as number | null) ?? null,
      inventoryTracked: (v.inventory_tracked as boolean | null) ?? null,
      inventoryOnHand: Number(v.inventory_on_hand ?? 0),
      optionValueIds: valuesByVariant.get(String(v.id)) ?? [],
    })),
    media: (media ?? []).map((m: Record<string, unknown>) => ({
      id: String(m.id), storagePath: String(m.storage_path), alt: (m.alt as string | null) ?? null,
      position: Number(m.position ?? 0), isPrimary: Boolean(m.is_primary),
    })),
    collectionIds: (pc ?? []).map((r: { collection_id: string }) => String(r.collection_id)),
    updatedAt: String(p.updated_at),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/catalog/__tests__/catalog-read.server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/catalog/types.ts app/lib/catalog/catalog.server.ts app/lib/catalog/__tests__/catalog-read.server.test.ts
git commit -m "feat(catalog): read layer (listProducts, getProduct)"
```

---

### Task 3: Catalog write layer — create / update / archive (+ re-projection)

**Files:**
- Modify: `app/lib/catalog/catalog.server.ts` (append write functions)
- Create: `app/lib/catalog/validate.ts` (input validation)
- Test: `app/lib/catalog/__tests__/catalog-write.server.test.ts`

**Interfaces:**
- Consumes: `getSupabase`; `projectProductToSkuDim` (Plan A); the slug helper from `app/lib/auth/tenant.server.ts` is NOT reused (different concern) — use a local `productHandle`.
- Produces:
  - `validateProductInput(raw: unknown): { ok: true; value: ProductInput } | { ok: false; code: string }`
  - `createProduct(shopId: string, input: ProductInput): Promise<{ id: string }>`
  - `updateProduct(shopId: string, productId: string, input: ProductInput): Promise<void>`
  - `setProductStatus(shopId: string, productId: string, status: ProductStatus): Promise<void>`
  - `writeOptions(sb, productId, options): Promise<Map<string, string>>` — extract the option/value-writing loop out of `writeProductChildren` into this helper (returns the label→value-id map) so both `createProduct` (via `writeProductChildren`) and `updateProduct` share one implementation.
  - All three call `projectProductToSkuDim` after writing.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const project = vi.fn().mockResolvedValue(undefined);
vi.mock("../project-sku-dim.server", () => ({ projectProductToSkuDim: project }));

const single = vi.fn().mockResolvedValue({ data: { id: "p1" }, error: null });
const insert = vi.fn(() => ({ select: () => ({ single }) }));
const insertPlain = vi.fn().mockResolvedValue({ error: null });
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: (table: string) => {
      if (table === "product_dim") return { insert };
      return { insert: insertPlain, delete: () => ({ eq: () => Promise.resolve({ error: null }) }) };
    },
  }),
}));

beforeEach(() => { project.mockClear(); insert.mockClear(); insertPlain.mockClear(); });

describe("createProduct", () => {
  it("rejects a product with no variants", async () => {
    const { validateProductInput } = await import("../validate");
    const r = validateProductInput({ title: "Tee", status: "active", variants: [] });
    expect(r.ok).toBe(false);
  });

  it("creates the product and re-projects sku_dim", async () => {
    const { createProduct } = await import("../catalog.server");
    const res = await createProduct("shop1", {
      title: "Tee", status: "active", variants: [{ sku: "T-S", retailPriceCents: 1999, inventoryOnHand: 5 }],
    });
    expect(res.id).toBe("p1");
    expect(project).toHaveBeenCalledWith("p1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/catalog/__tests__/catalog-write.server.test.ts`
Expected: FAIL — `validateProductInput` / `createProduct` not found.

- [ ] **Step 3: Write `validate.ts`**

```typescript
// app/lib/catalog/validate.ts
import type { ProductInput, ProductStatus } from "./types";

const STATUSES: ProductStatus[] = ["draft", "active", "archived"];

export function validateProductInput(
  raw: unknown,
): { ok: true; value: ProductInput } | { ok: false; code: string } {
  if (typeof raw !== "object" || raw === null) return { ok: false, code: "invalid_body" };
  const r = raw as Record<string, unknown>;

  const title = typeof r.title === "string" ? r.title.trim() : "";
  if (!title) return { ok: false, code: "missing_title" };
  const status = STATUSES.includes(r.status as ProductStatus) ? (r.status as ProductStatus) : null;
  if (!status) return { ok: false, code: "invalid_status" };
  if (!Array.isArray(r.variants) || r.variants.length === 0) return { ok: false, code: "no_variants" };

  const variants = (r.variants as unknown[]).map((v) => {
    const o = (typeof v === "object" && v ? v : {}) as Record<string, unknown>;
    return {
      id: typeof o.id === "string" ? o.id : undefined,
      sku: typeof o.sku === "string" ? o.sku : undefined,
      title: typeof o.title === "string" ? o.title : undefined,
      retailPriceCents: Number.isFinite(o.retailPriceCents) ? Number(o.retailPriceCents) : undefined,
      unitCostCents: Number.isFinite(o.unitCostCents) ? Number(o.unitCostCents) : undefined,
      inventoryPolicy: typeof o.inventoryPolicy === "string" ? o.inventoryPolicy : undefined,
      inventoryTracked: typeof o.inventoryTracked === "boolean" ? o.inventoryTracked : undefined,
      inventoryOnHand: Number.isFinite(o.inventoryOnHand) ? Math.max(0, Math.trunc(Number(o.inventoryOnHand))) : 0,
      optionValues: Array.isArray(o.optionValues) ? (o.optionValues as unknown[]).filter((x): x is string => typeof x === "string") : undefined,
    };
  });
  for (const v of variants) {
    if (v.retailPriceCents != null && v.retailPriceCents < 0) return { ok: false, code: "negative_price" };
  }

  const options = Array.isArray(r.options)
    ? (r.options as unknown[]).map((o) => {
        const oo = (typeof o === "object" && o ? o : {}) as Record<string, unknown>;
        return { name: String(oo.name ?? "").trim(), values: Array.isArray(oo.values) ? (oo.values as unknown[]).map(String) : [] };
      }).filter((o) => o.name && o.values.length)
    : undefined;

  return {
    ok: true,
    value: {
      title,
      status,
      vendor: typeof r.vendor === "string" ? r.vendor : undefined,
      category: typeof r.category === "string" ? r.category : undefined,
      description: typeof r.description === "string" ? r.description : undefined,
      tags: Array.isArray(r.tags) ? (r.tags as unknown[]).filter((t): t is string => typeof t === "string") : undefined,
      options,
      variants,
      collectionIds: Array.isArray(r.collectionIds) ? (r.collectionIds as unknown[]).filter((c): c is string => typeof c === "string") : undefined,
    },
  };
}
```

- [ ] **Step 4: Append the write functions to `catalog.server.ts`**

```typescript
import { randomBytes } from "node:crypto";
import { projectProductToSkuDim } from "./project-sku-dim.server";
import type { ProductInput, ProductStatus } from "./types";

function productHandle(title: string): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "product";
  return `${base}-${randomBytes(3).toString("hex")}`;
}

// Writes the full product graph, then projects sku_dim. Supabase has no client
// transaction, so writes are ordered parent→child; a failure throws and the
// route surfaces it (no projection runs on a failed write).
export async function createProduct(shopId: string, input: ProductInput): Promise<{ id: string }> {
  const sb = getSupabase();
  // Insert the product; retry with a fresh handle on the rare unique(shop_id,
  // handle) collision (productHandle appends random bytes, so a clash is
  // unlikely but possible). Throw on any other error or after 3 tries.
  let productId = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: prod, error: pErr } = await sb
      .from("product_dim")
      .insert({
        shop_id: shopId, handle: productHandle(input.title), title: input.title, status: input.status,
        vendor: input.vendor ?? null, category: input.category ?? null, description: input.description ?? null,
        tags: input.tags ?? [],
      })
      .select("id")
      .single();
    if (!pErr) { productId = String(prod.id); break; }
    if ((pErr as { code?: string }).code !== "23505" || attempt === 2) throw pErr;
  }

  await writeProductChildren(shopId, productId, input);
  await projectProductToSkuDim(productId);
  return { id: productId };
}

// Updates a product. Options + collections have no external references, so they
// are wiped + rewritten. VARIANTS are referenced by order_line_fact (and by
// sku_dim via the id==id invariant), so they are RECONCILED BY ID — never wiped
// and re-inserted (that would mint new ids, orphan past orders, and break the
// projection). Media is managed separately (Task 5) so it survives an edit.
export async function updateProduct(shopId: string, productId: string, input: ProductInput): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb
    .from("product_dim")
    .update({
      title: input.title, status: input.status, vendor: input.vendor ?? null, category: input.category ?? null,
      description: input.description ?? null, tags: input.tags ?? [], updated_at: new Date().toISOString(),
    })
    .eq("shop_id", shopId).eq("id", productId);
  if (error) throw error;

  // Options/values + collections: safe to wipe + rewrite (no external refs).
  await sb.from("product_option").delete().eq("product_id", productId); // cascades option_values
  await sb.from("product_collection").delete().eq("product_id", productId);
  const valueIdByLabel = await writeOptions(sb, productId, input.options ?? []); // extracted from writeProductChildren

  // Variants: delete only the ones the merchant removed; keep the rest by id.
  const keepIds = input.variants.map((v) => v.id).filter((id): id is string => Boolean(id));
  let del = sb.from("variant_dim").delete().eq("product_id", productId);
  if (keepIds.length) del = del.not("id", "in", `(${keepIds.map((i) => `'${i}'`).join(",")})`);
  const { error: delErr } = await del;
  if (delErr) throw delErr;

  for (const [i, v] of input.variants.entries()) {
    const fields = {
      sku: v.sku ?? null, title: v.title ?? "Default", retail_price_cents: v.retailPriceCents ?? null,
      unit_cost_cents: v.unitCostCents ?? null, inventory_policy: v.inventoryPolicy ?? null,
      inventory_tracked: v.inventoryTracked ?? null, inventory_on_hand: v.inventoryOnHand ?? 0, position: i,
    };
    let variantId = v.id ?? null;
    if (variantId) {
      const { error: uErr } = await sb.from("variant_dim").update(fields).eq("shop_id", shopId).eq("id", variantId);
      if (uErr) throw uErr;
    } else {
      const { data: ins, error: iErr } = await sb.from("variant_dim").insert({ shop_id: shopId, product_id: productId, ...fields }).select("id").single();
      if (iErr) throw iErr;
      variantId = String(ins.id);
    }
    // Rebuild this variant's option-value links (option-value ids changed above).
    await sb.from("variant_option_value").delete().eq("variant_id", variantId);
    const links = (v.optionValues ?? []).map((l) => valueIdByLabel.get(l)).filter((x): x is string => Boolean(x))
      .map((option_value_id) => ({ variant_id: variantId, option_value_id }));
    if (links.length) { const { error: lErr } = await sb.from("variant_option_value").insert(links); if (lErr) throw lErr; }
  }

  if (input.collectionIds?.length) {
    const { error: cErr } = await sb.from("product_collection").insert(input.collectionIds.map((collection_id) => ({ product_id: productId, collection_id })));
    if (cErr) throw cErr;
  }

  await projectProductToSkuDim(productId);
}

export async function setProductStatus(shopId: string, productId: string, status: ProductStatus): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.from("product_dim").update({ status, updated_at: new Date().toISOString() }).eq("shop_id", shopId).eq("id", productId);
  if (error) throw error;
  await projectProductToSkuDim(productId);
}

async function writeProductChildren(shopId: string, productId: string, input: ProductInput): Promise<void> {
  const sb = getSupabase();

  // Options + values; build a label→value-id map so variants can link.
  const valueIdByLabel = new Map<string, string>();
  for (const [i, opt] of (input.options ?? []).entries()) {
    const { data: o, error: oErr } = await sb.from("product_option").insert({ product_id: productId, name: opt.name, position: i }).select("id").single();
    if (oErr) throw oErr;
    for (const [j, val] of opt.values.entries()) {
      const { data: ov, error: ovErr } = await sb.from("product_option_value").insert({ option_id: o.id, value: val, position: j }).select("id").single();
      if (ovErr) throw ovErr;
      valueIdByLabel.set(val, String(ov.id));
    }
  }

  // Variants + their option-value links.
  for (const [i, v] of input.variants.entries()) {
    const { data: variant, error: vErr } = await sb
      .from("variant_dim")
      .insert({
        shop_id: shopId, product_id: productId, sku: v.sku ?? null, title: v.title ?? "Default",
        retail_price_cents: v.retailPriceCents ?? null, unit_cost_cents: v.unitCostCents ?? null,
        inventory_policy: v.inventoryPolicy ?? null, inventory_tracked: v.inventoryTracked ?? null,
        inventory_on_hand: v.inventoryOnHand ?? 0, position: i,
      })
      .select("id")
      .single();
    if (vErr) throw vErr;
    const links = (v.optionValues ?? []).map((label) => valueIdByLabel.get(label)).filter((x): x is string => Boolean(x))
      .map((option_value_id) => ({ variant_id: variant.id, option_value_id }));
    if (links.length) {
      const { error: lErr } = await sb.from("variant_option_value").insert(links);
      if (lErr) throw lErr;
    }
  }

  // Collections.
  if (input.collectionIds?.length) {
    const { error: cErr } = await sb.from("product_collection").insert(input.collectionIds.map((collection_id) => ({ product_id: productId, collection_id })));
    if (cErr) throw cErr;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run app/lib/catalog/__tests__/catalog-write.server.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/lib/catalog/catalog.server.ts app/lib/catalog/validate.ts app/lib/catalog/__tests__/catalog-write.server.test.ts
git commit -m "feat(catalog): write layer (create/update/status) with sku_dim re-projection"
```

---

### Task 4: Collections data layer

**Files:**
- Modify: `app/lib/catalog/catalog.server.ts`
- Test: `app/lib/catalog/__tests__/catalog-collections.server.test.ts`

**Interfaces:**
- Produces:
  - `listCollections(shopId: string): Promise<Array<{ id: string; title: string; handle: string }>>`
  - `createCollection(shopId: string, title: string): Promise<{ id: string }>`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from "vitest";
const single = vi.fn().mockResolvedValue({ data: { id: "c1" }, error: null });
const insert = vi.fn(() => ({ select: () => ({ single }) }));
const order = vi.fn().mockResolvedValue({ data: [{ id: "c1", title: "Summer", handle: "summer" }], error: null });
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: () => ({ insert, select: () => ({ eq: () => ({ order }) }) }) }),
}));
vi.mock("../project-sku-dim.server", () => ({ projectProductToSkuDim: vi.fn() }));

describe("collections", () => {
  it("lists collections", async () => {
    const { listCollections } = await import("../catalog.server");
    expect(await listCollections("shop1")).toEqual([{ id: "c1", title: "Summer", handle: "summer" }]);
  });
  it("creates a collection with a slug handle", async () => {
    const { createCollection } = await import("../catalog.server");
    expect(await createCollection("shop1", "Summer Sale")).toEqual({ id: "c1" });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ shop_id: "shop1", title: "Summer Sale", handle: "summer-sale" }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/catalog/__tests__/catalog-collections.server.test.ts`
Expected: FAIL — functions not found.

- [ ] **Step 3: Append to `catalog.server.ts`**

```typescript
export async function listCollections(shopId: string): Promise<Array<{ id: string; title: string; handle: string }>> {
  const { data, error } = await getSupabase().from("collection_dim").select("id, title, handle").eq("shop_id", shopId).order("title");
  if (error) throw error;
  return (data ?? []).map((c: Record<string, unknown>) => ({ id: String(c.id), title: String(c.title), handle: String(c.handle) }));
}

export async function createCollection(shopId: string, title: string): Promise<{ id: string }> {
  const handle = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "collection";
  const { data, error } = await getSupabase().from("collection_dim").insert({ shop_id: shopId, title: title.trim(), handle }).select("id").single();
  if (error) throw error;
  return { id: String(data.id) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/catalog/__tests__/catalog-collections.server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/catalog/catalog.server.ts app/lib/catalog/__tests__/catalog-collections.server.test.ts
git commit -m "feat(catalog): collections data layer"
```

---

### Task 5: Image upload/delete to Storage

**Files:**
- Create: `app/lib/catalog/media.server.ts`
- Test: `app/lib/catalog/__tests__/media.server.test.ts`

**Interfaces:**
- Consumes: `getSupabase`.
- Produces:
  - `uploadProductMedia(shopId: string, productId: string, file: { bytes: Uint8Array; filename: string; contentType: string }): Promise<{ id: string; storagePath: string }>` — validates image type/size, uploads to `product-media`, inserts `product_media` (first image of a product becomes `is_primary`).
  - `deleteProductMedia(shopId: string, mediaId: string): Promise<void>` — removes the row + the Storage object.
  - `PRODUCT_MEDIA_BUCKET = "product-media"`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
const upload = vi.fn().mockResolvedValue({ error: null });
const single = vi.fn().mockResolvedValue({ data: { id: "m1" }, error: null });
const insert = vi.fn(() => ({ select: () => ({ single }) }));
const countSingle = vi.fn().mockResolvedValue({ count: 0, error: null });
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    storage: { from: () => ({ upload }) },
    from: () => ({ insert, select: () => ({ eq: () => Promise.resolve({ count: 0, error: null }) }) }),
  }),
}));

beforeEach(() => { upload.mockClear(); insert.mockClear(); });

describe("uploadProductMedia", () => {
  it("rejects a non-image file", async () => {
    const { uploadProductMedia } = await import("../media.server");
    await expect(uploadProductMedia("shop1", "p1", { bytes: new Uint8Array([1]), filename: "x.pdf", contentType: "application/pdf" }))
      .rejects.toThrow();
  });
  it("uploads an image and records the row", async () => {
    const { uploadProductMedia } = await import("../media.server");
    const res = await uploadProductMedia("shop1", "p1", { bytes: new Uint8Array([1, 2]), filename: "tee.png", contentType: "image/png" });
    expect(res.id).toBe("m1");
    expect(upload).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/catalog/__tests__/media.server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `media.server.ts`**

```typescript
// app/lib/catalog/media.server.ts
import { randomBytes } from "node:crypto";
import { getSupabase } from "../supabase.server";

export const PRODUCT_MEDIA_BUCKET = "product-media";
const ALLOWED = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_BYTES = 8 * 1024 * 1024;

export async function uploadProductMedia(
  shopId: string,
  productId: string,
  file: { bytes: Uint8Array; filename: string; contentType: string },
): Promise<{ id: string; storagePath: string }> {
  if (!ALLOWED.has(file.contentType)) throw new Error("unsupported_media_type");
  if (file.bytes.byteLength > MAX_BYTES) throw new Error("media_too_large");

  const sb = getSupabase();
  const ext = file.contentType.split("/")[1] || "bin";
  const storagePath = `${shopId}/${productId}/${randomBytes(8).toString("hex")}.${ext}`;
  const { error: upErr } = await sb.storage.from(PRODUCT_MEDIA_BUCKET).upload(storagePath, file.bytes, { contentType: file.contentType, upsert: false });
  if (upErr) throw upErr;

  // First image of a product is primary.
  const { count } = await sb.from("product_media").select("id", { count: "exact", head: true }).eq("product_id", productId);
  const { data, error } = await sb
    .from("product_media")
    .insert({ product_id: productId, storage_path: storagePath, position: count ?? 0, is_primary: (count ?? 0) === 0 })
    .select("id")
    .single();
  if (error) throw error;
  return { id: String(data.id), storagePath };
}

export async function deleteProductMedia(shopId: string, mediaId: string): Promise<void> {
  const sb = getSupabase();
  const { data: row, error } = await sb.from("product_media").select("storage_path, product_id").eq("id", mediaId).maybeSingle();
  if (error) throw error;
  if (!row) return;
  await sb.storage.from(PRODUCT_MEDIA_BUCKET).remove([String(row.storage_path)]);
  await sb.from("product_media").delete().eq("id", mediaId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/catalog/__tests__/media.server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/catalog/media.server.ts app/lib/catalog/__tests__/media.server.test.ts
git commit -m "feat(catalog): product image upload/delete to Storage"
```

---

### Task 6: API routes — products (list/create, get/update/archive)

**Files:**
- Create: `app/routes/dashboard.api.catalog.products._index.tsx` (GET list, POST create)
- Create: `app/routes/dashboard.api.catalog.products.$id.tsx` (GET one, PUT update, DELETE archive)
- Test: `app/routes/__tests__/dashboard.api.catalog.products.test.ts`

**Interfaces:**
- Consumes: `requireDashboardSession`, `requireSameOrigin`, `dashboardJson`, `jsonError`; `listProducts`, `createProduct`, `getProduct`, `updateProduct`, `setProductStatus`, `validateProductInput`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession: vi.fn().mockResolvedValue({ shopId: "shop1", shopDomain: null, userId: "u1", sessionId: "s1" }) }));
vi.mock("~/lib/dashboard/http.server", () => ({
  requireSameOrigin: vi.fn(),
  dashboardJson: async (fn: () => Promise<unknown>) => new Response(JSON.stringify(await fn()), { status: 200 }),
  jsonError: (s: number, e: string) => new Response(JSON.stringify({ error: e }), { status: s }),
}));
const listProducts = vi.fn().mockResolvedValue({ products: [], total: 0 });
const createProduct = vi.fn().mockResolvedValue({ id: "p1" });
vi.mock("~/lib/catalog/catalog.server", () => ({ listProducts, createProduct, getProduct: vi.fn(), updateProduct: vi.fn(), setProductStatus: vi.fn() }));
vi.mock("~/lib/catalog/validate", () => ({ validateProductInput: (b: unknown) => ({ ok: true, value: b }) }));

beforeEach(() => { listProducts.mockClear(); createProduct.mockClear(); });

describe("catalog products route", () => {
  it("GET lists products for the session shop", async () => {
    const { loader } = await import("../dashboard.api.catalog.products._index");
    const res = (await loader({ request: new Request("https://app.x/dashboard/api/catalog/products") } as never)) as Response;
    expect(res.status).toBe(200);
    expect(listProducts).toHaveBeenCalledWith("shop1", expect.any(Object));
  });

  it("POST creates a product", async () => {
    const { action } = await import("../dashboard.api.catalog.products._index");
    const req = new Request("https://app.x/dashboard/api/catalog/products", { method: "POST", body: JSON.stringify({ title: "Tee", status: "active", variants: [{ sku: "S" }] }), headers: { "Content-Type": "application/json" } });
    const res = (await action({ request: req } as never)) as Response;
    expect(res.status).toBe(200);
    expect(createProduct).toHaveBeenCalledWith("shop1", expect.objectContaining({ title: "Tee" }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/routes/__tests__/dashboard.api.catalog.products.test.ts`
Expected: FAIL — route modules not found.

- [ ] **Step 3: Write the two route files**

`app/routes/dashboard.api.catalog.products._index.tsx`:

```tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { listProducts, createProduct } from "~/lib/catalog/catalog.server";
import { validateProductInput } from "~/lib/catalog/validate";
import type { ProductStatus } from "~/lib/catalog/types";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  return dashboardJson(() =>
    listProducts(session.shopId, {
      search: url.searchParams.get("search") ?? undefined,
      status: (["draft", "active", "archived"] as ProductStatus[]).includes(status as ProductStatus) ? (status as ProductStatus) : undefined,
      offset: Number(url.searchParams.get("offset") ?? 0) || 0,
    }),
  );
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");
  let body: unknown;
  try { body = await request.json(); } catch { return jsonError(422, "invalid_json"); }
  const v = validateProductInput(body);
  if (!v.ok) return jsonError(422, v.code);
  return dashboardJson(() => createProduct(session.shopId, v.value));
}
```

`app/routes/dashboard.api.catalog.products.$id.tsx`:

```tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { getProduct, updateProduct, setProductStatus } from "~/lib/catalog/catalog.server";
import { validateProductInput } from "~/lib/catalog/validate";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const id = String(params.id);
  return dashboardJson(async () => {
    const product = await getProduct(session.shopId, id);
    if (!product) throw jsonError(404, "not_found");
    return { product };
  });
}

export async function action({ request, params }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  const id = String(params.id);

  if (request.method === "DELETE") {
    return dashboardJson(async () => {
      await setProductStatus(session.shopId, id, "archived");
      return { ok: true };
    });
  }
  if (request.method === "PUT") {
    let body: unknown;
    try { body = await request.json(); } catch { return jsonError(422, "invalid_json"); }
    const v = validateProductInput(body);
    if (!v.ok) return jsonError(422, v.code);
    return dashboardJson(async () => {
      await updateProduct(session.shopId, id, v.value);
      return { ok: true };
    });
  }
  return jsonError(405, "method_not_allowed");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/routes/__tests__/dashboard.api.catalog.products.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/routes/dashboard.api.catalog.products._index.tsx app/routes/dashboard.api.catalog.products.$id.tsx app/routes/__tests__/dashboard.api.catalog.products.test.ts
git commit -m "feat(catalog): product list/create/get/update/archive API"
```

---

### Task 7: API routes — collections + media

**Files:**
- Create: `app/routes/dashboard.api.catalog.collections.tsx` (GET list, POST create)
- Create: `app/routes/dashboard.api.catalog.media.tsx` (POST upload multipart, DELETE remove)
- Test: `app/routes/__tests__/dashboard.api.catalog.collections.test.ts`

**Interfaces:**
- Consumes: `requireDashboardSession`, `requireSameOrigin`, `dashboardJson`, `jsonError`; `listCollections`, `createCollection`; `uploadProductMedia`, `deleteProductMedia`.

- [ ] **Step 1: Write the failing test (collections + media-upload happy paths)**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession: vi.fn().mockResolvedValue({ shopId: "shop1", shopDomain: null, userId: "u1", sessionId: "s1" }) }));
vi.mock("~/lib/dashboard/http.server", () => ({
  requireSameOrigin: vi.fn(),
  dashboardJson: async (fn: () => Promise<unknown>) => new Response(JSON.stringify(await fn()), { status: 200 }),
  jsonError: (s: number, e: string) => new Response(JSON.stringify({ error: e }), { status: s }),
}));
const createCollection = vi.fn().mockResolvedValue({ id: "c1" });
vi.mock("~/lib/catalog/catalog.server", () => ({ listCollections: vi.fn().mockResolvedValue([]), createCollection }));
const uploadProductMedia = vi.fn().mockResolvedValue({ id: "m1", storagePath: "shop1/p1/x.png" });
vi.mock("~/lib/catalog/media.server", () => ({ uploadProductMedia, deleteProductMedia: vi.fn() }));

beforeEach(() => { createCollection.mockClear(); uploadProductMedia.mockClear(); });

describe("catalog collections + media routes", () => {
  it("POST creates a collection", async () => {
    const { action } = await import("../dashboard.api.catalog.collections");
    const req = new Request("https://app.x/dashboard/api/catalog/collections", { method: "POST", body: JSON.stringify({ title: "Summer" }), headers: { "Content-Type": "application/json" } });
    const res = (await action({ request: req } as never)) as Response;
    expect(res.status).toBe(200);
    expect(createCollection).toHaveBeenCalledWith("shop1", "Summer");
  });

  it("POST uploads media from multipart", async () => {
    const { action } = await import("../dashboard.api.catalog.media");
    const fd = new FormData();
    fd.set("productId", "p1");
    fd.set("file", new File([new Uint8Array([1, 2])], "tee.png", { type: "image/png" }));
    const req = new Request("https://app.x/dashboard/api/catalog/media", { method: "POST", body: fd });
    const res = (await action({ request: req } as never)) as Response;
    expect(res.status).toBe(200);
    expect(uploadProductMedia).toHaveBeenCalledWith("shop1", "p1", expect.objectContaining({ filename: "tee.png", contentType: "image/png" }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/routes/__tests__/dashboard.api.catalog.collections.test.ts`
Expected: FAIL — route modules not found.

- [ ] **Step 3: Write the routes**

`app/routes/dashboard.api.catalog.collections.tsx`:

```tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { listCollections, createCollection } from "~/lib/catalog/catalog.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => ({ collections: await listCollections(session.shopId) }));
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");
  let body: { title?: unknown };
  try { body = (await request.json()) as { title?: unknown }; } catch { return jsonError(422, "invalid_json"); }
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return jsonError(422, "missing_title");
  return dashboardJson(() => createCollection(session.shopId, title));
}
```

`app/routes/dashboard.api.catalog.media.tsx`:

```tsx
import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { uploadProductMedia, deleteProductMedia } from "~/lib/catalog/media.server";

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);

  if (request.method === "DELETE") {
    let body: { mediaId?: unknown };
    try { body = (await request.json()) as { mediaId?: unknown }; } catch { return jsonError(422, "invalid_json"); }
    const mediaId = typeof body.mediaId === "string" ? body.mediaId : "";
    if (!mediaId) return jsonError(422, "missing_media_id");
    return dashboardJson(async () => { await deleteProductMedia(session.shopId, mediaId); return { ok: true }; });
  }

  if (request.method !== "POST") return jsonError(405, "method_not_allowed");
  const form = await request.formData();
  const productId = String(form.get("productId") ?? "");
  const file = form.get("file");
  if (!productId) return jsonError(422, "missing_product_id");
  if (!(file instanceof File) || file.size === 0) return jsonError(422, "missing_file");
  const bytes = new Uint8Array(await file.arrayBuffer());
  return dashboardJson(() => uploadProductMedia(session.shopId, productId, { bytes, filename: file.name, contentType: file.type }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/routes/__tests__/dashboard.api.catalog.collections.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/routes/dashboard.api.catalog.collections.tsx app/routes/dashboard.api.catalog.media.tsx app/routes/__tests__/dashboard.api.catalog.collections.test.ts
git commit -m "feat(catalog): collections + media upload API"
```

---

### Task 8: Full gate

- [ ] **Step 1: Run the whole gate and paste results**

```bash
npm run typecheck   # exit 0
npm run lint        # exit 0
npm run build       # exit 0
npx vitest run      # all green
```
Expected: every command exits 0.

- [ ] **Step 2: Commit any fixups**

```bash
git add -A
git commit -m "chore(catalog): green gate for catalog API"
```

---

## Self-Review

**Spec coverage (against `docs/superpowers/specs/2026-06-28-slice-1-owned-catalog-design.md`):**
- Product CRUD (title/status/vendor/tags/description) → Tasks 2-3, 6. ✅
- Options → variant matrix (SKU + price + stock count) → Task 3 `writeProductChildren`, `inventoryOnHand`. ✅
- Image gallery (upload, primary) → Task 5, 7. ✅
- Collections (create/assign) → Tasks 4, 7. ✅
- Dashboard-only + `dashboard.api.*` pattern + `requireSameOrigin` + session scoping by `shopId` → Tasks 6-7. ✅
- Every mutation re-projects `sku_dim` (engine stays correct) → Task 3 calls `projectProductToSkuDim`. ✅
- Supabase Storage `product-media` bucket → Task 1. ✅

**Out of scope (Plan B2 — the UI):** the product-list screen, product-editor screen (gallery reorder, option/variant grid widget), collections-manager screen, signed-URL image rendering, and the `dashboard/client.ts` typed fetch wrappers.

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `ProductInput` / `VariantInput` / `ProductStatus` from `types.ts` are used identically across `validate.ts`, `catalog.server.ts`, and both route files. `createProduct → {id}`, `getProduct → ProductDetail | null`, `projectProductToSkuDim(productId)` (Plan A) match their definitions.

**Key invariant carried from Plan A:** every write path ends in `projectProductToSkuDim(productId)`, so `variant_dim.id == sku_dim.id` stays true and the engine never desyncs.
