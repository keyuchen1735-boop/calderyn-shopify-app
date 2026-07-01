# Owned-variant Shipping Dimensions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add package dimensions (length/width/height, metric mm) to the owned `variant_dim`, editable in the dashboard product editor and validated at write time, so Calderyn's live shipping quote engine can compute a real rate instead of an estimate.

**Architecture:** Four additive nullable integer columns on `variant_dim` (weight `grams` already exists). A pure `shipping-dims.ts` module validates (format-strict) and converts metric→imperial for the engine. The catalog write path validates + persists; `getProduct` returns the fields; the `ProductEditor` surfaces weight + dimension inputs and an "incomplete → estimated rates" warning. The quote engine's consumption of the converter is Eric's seam and is NOT wired here.

**Tech Stack:** TypeScript (strict, ES modules), Supabase (Postgres migrations), React (dashboard editor), Vitest.

## Global Constraints

- **TypeScript only, strict.** No `any` without written justification; `tsc --noEmit` authoritative.
- **Canonical field names/types** (used identically across every task):
  - DB columns on `variant_dim`: `grams int` (exists), `length_mm int`, `width_mm int`, `height_mm int` (new, nullable).
  - DTO / input camelCase: `grams?: number`, `lengthMm?: number`, `widthMm?: number`, `heightMm?: number` (optional on `VariantInput`/`VariantDraft`; `number | null` on `ProductDetail.variants[]`).
- **Storage is metric integers.** Millimetres + grams. Conversion to inches/ounces happens only in `toParcelDims`.
- **Validation is format-strict, presence-soft.** A provided value must be an integer `> 0` and `<=` ceiling (`length/width/height <= 3000` mm, `grams <= 2_000_000`); reject at the write boundary. Missing values are allowed to save (no hard block); incompleteness is surfaced as an editor warning.
- **Do not modify the shipping quote engine** (`app/lib/shipping/*`, `app/lib/commerce/*`) — this feature delivers the data + `toParcelDims`; Eric wires the engine read.
- **Browser hygiene** (CLAUDE.md): no AI/tool/provenance markers in any comment/identifier; the dashboard editor is a browser-visible surface.
- **Dashboard-only surface** — the owned catalog editor has no embedded-app mirror (embedded app uses Shopify product data). Parity satisfied by shipping the dashboard editor.
- **Migration numbering** sequences after `20260630170000_owned_event_ingest.sql`.

---

### Task 1: Migration — dimension columns on `variant_dim`

**Files:**
- Create: `supabase/migrations/20260630180000_variant_dimensions.sql`

**Interfaces:**
- Produces: `variant_dim.length_mm int`, `variant_dim.width_mm int`, `variant_dim.height_mm int` (nullable).

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260630180000_variant_dimensions.sql`:

```sql
-- Owned-variant package dimensions (platform pivot #5-shipping). Metric integers,
-- consistent with the existing variant_dim.grams weight; the shipping quote engine
-- converts to inches/ounces at read time. Additive + nullable, so existing variants
-- and readers are unaffected; presence is validated softly (a shippable variant may
-- lack dimensions and quote at low confidence).
alter table public.variant_dim
  add column if not exists length_mm integer,
  add column if not exists width_mm integer,
  add column if not exists height_mm integer;
```

- [ ] **Step 2: Apply + verify (controller-owned)**

The controller applies this via the Supabase MCP (`apply_migration`, name `variant_dimensions`) and confirms the three columns exist on `variant_dim`. (Do not run MCP tools as the implementer.)

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260630180000_variant_dimensions.sql
git commit -m "catalog: variant_dim length/width/height_mm columns"
```

---

### Task 2: Shipping-dims module (validate + complete + convert)

**Files:**
- Create: `app/lib/catalog/shipping-dims.ts`
- Test: `app/lib/catalog/__tests__/shipping-dims.test.ts`

**Interfaces:**
- Produces:
  - `interface VariantShippingFields { grams?: number | null; lengthMm?: number | null; widthMm?: number | null; heightMm?: number | null; requiresShipping?: boolean | null }`
  - `type DimValidation = { ok: true } | { ok: false; error: string }`
  - `function validateVariantDims(v: VariantShippingFields): DimValidation`
  - `function isShippingComplete(v: VariantShippingFields): boolean`
  - `interface ParcelDims { lengthIn: number | null; widthIn: number | null; heightIn: number | null; weightOz: number | null }`
  - `function toParcelDims(v: VariantShippingFields): ParcelDims`

- [ ] **Step 1: Write the failing test**

Create `app/lib/catalog/__tests__/shipping-dims.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { validateVariantDims, isShippingComplete, toParcelDims } from "../shipping-dims";

describe("validateVariantDims", () => {
  it("accepts positive integer metric values", () => {
    expect(validateVariantDims({ grams: 500, lengthMm: 200, widthMm: 150, heightMm: 100 })).toEqual({ ok: true });
  });
  it("treats missing fields as valid (presence-soft)", () => {
    expect(validateVariantDims({ grams: 500 })).toEqual({ ok: true });
    expect(validateVariantDims({})).toEqual({ ok: true });
  });
  it("rejects zero, negative, and non-integer values with the field name", () => {
    expect(validateVariantDims({ lengthMm: 0 })).toMatchObject({ ok: false, error: expect.stringContaining("lengthMm") });
    expect(validateVariantDims({ grams: -1 })).toMatchObject({ ok: false });
    expect(validateVariantDims({ widthMm: 1.5 })).toMatchObject({ ok: false, error: expect.stringContaining("widthMm") });
  });
  it("rejects values over the fat-finger ceiling", () => {
    expect(validateVariantDims({ heightMm: 3001 })).toMatchObject({ ok: false });
    expect(validateVariantDims({ grams: 2_000_001 })).toMatchObject({ ok: false });
  });
});

describe("isShippingComplete", () => {
  it("is false when a shippable variant misses any of weight/dims", () => {
    expect(isShippingComplete({ grams: 500, lengthMm: 200, widthMm: 150 })).toBe(false);
  });
  it("is true when weight and all dims are present", () => {
    expect(isShippingComplete({ grams: 500, lengthMm: 200, widthMm: 150, heightMm: 100 })).toBe(true);
  });
  it("is true (n/a) when the variant does not require shipping", () => {
    expect(isShippingComplete({ requiresShipping: false })).toBe(true);
  });
});

describe("toParcelDims", () => {
  it("converts mm to inches and grams to ounces (rounded to 2dp)", () => {
    expect(toParcelDims({ grams: 28, lengthMm: 254, widthMm: 254, heightMm: 254 })).toEqual({
      lengthIn: 10, widthIn: 10, heightIn: 10, weightOz: 0.99,
    });
  });
  it("passes missing metric fields through as null", () => {
    expect(toParcelDims({ grams: 28 })).toEqual({ lengthIn: null, widthIn: null, heightIn: null, weightOz: 0.99 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/catalog/__tests__/shipping-dims.test.ts`
Expected: FAIL — cannot resolve `../shipping-dims`.

- [ ] **Step 3: Write the implementation**

Create `app/lib/catalog/shipping-dims.ts`:

```ts
// Shipping dimensions: validation + metric->imperial conversion for owned variants.
// Weight is stored in grams and dimensions in millimetres on variant_dim (metric
// integers); the shipping quote engine consumes inches + ounces, so toParcelDims
// converts at the read boundary. Validation is format-strict (a provided value must be
// a positive integer within a sane ceiling) but presence-soft (a shippable variant may
// still save with fields missing and quote at low confidence).

export interface VariantShippingFields {
  grams?: number | null;
  lengthMm?: number | null;
  widthMm?: number | null;
  heightMm?: number | null;
  requiresShipping?: boolean | null;
}

const MAX_MM = 3000; // 3 m per axis
const MAX_GRAMS = 2_000_000; // 2 t
const MM_PER_IN = 25.4;
const G_PER_OZ = 28.349523125;

const FIELD_MAX: Record<"grams" | "lengthMm" | "widthMm" | "heightMm", number> = {
  grams: MAX_GRAMS,
  lengthMm: MAX_MM,
  widthMm: MAX_MM,
  heightMm: MAX_MM,
};

export type DimValidation = { ok: true } | { ok: false; error: string };

// Format-strict: each PROVIDED field must be an integer > 0 and <= its ceiling.
// null/undefined = "not provided" and is allowed (presence-soft).
export function validateVariantDims(v: VariantShippingFields): DimValidation {
  for (const key of ["grams", "lengthMm", "widthMm", "heightMm"] as const) {
    const val = v[key];
    if (val == null) continue;
    if (typeof val !== "number" || !Number.isInteger(val) || val <= 0) {
      return { ok: false, error: `${key} must be a positive integer` };
    }
    if (val > FIELD_MAX[key]) {
      return { ok: false, error: `${key} exceeds the maximum of ${FIELD_MAX[key]}` };
    }
  }
  return { ok: true };
}

// A shippable variant is "shipping-complete" only when weight AND all three dims are
// set. A non-shipping variant (requiresShipping === false) is complete by definition.
export function isShippingComplete(v: VariantShippingFields): boolean {
  if (v.requiresShipping === false) return true;
  return v.grams != null && v.lengthMm != null && v.widthMm != null && v.heightMm != null;
}

export interface ParcelDims {
  lengthIn: number | null;
  widthIn: number | null;
  heightIn: number | null;
  weightOz: number | null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

// Convert stored metric fields to the shipping engine's inches/ounces. A missing metric
// field passes through as null (the engine treats null as "unknown" and falls back to an
// estimated parcel).
export function toParcelDims(v: VariantShippingFields): ParcelDims {
  return {
    lengthIn: v.lengthMm == null ? null : round2(v.lengthMm / MM_PER_IN),
    widthIn: v.widthMm == null ? null : round2(v.widthMm / MM_PER_IN),
    heightIn: v.heightMm == null ? null : round2(v.heightMm / MM_PER_IN),
    weightOz: v.grams == null ? null : round2(v.grams / G_PER_OZ),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/lib/catalog/__tests__/shipping-dims.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/catalog/shipping-dims.ts app/lib/catalog/__tests__/shipping-dims.test.ts
git commit -m "catalog: shipping-dims validation + metric->imperial converter"
```

---

### Task 3: Write path — validate + persist on create/update

**Files:**
- Modify: `app/lib/catalog/types.ts` (`VariantInput`)
- Modify: `app/lib/catalog/catalog.server.ts` (`writeProductChildren` insert, `updateProduct` `fields`, + a per-variant validate call)
- Test: `app/lib/catalog/__tests__/catalog-shipping-dims.server.test.ts`

**Interfaces:**
- Consumes: `validateVariantDims` (Task 2).
- Produces: `VariantInput` gains `grams?: number; lengthMm?: number; widthMm?: number; heightMm?: number`. `createProduct`/`updateProduct` persist `grams,length_mm,width_mm,height_mm` and throw a `validateVariantDims` error before writing an invalid variant.

- [ ] **Step 1: Add the input type fields**

In `app/lib/catalog/types.ts`, inside `interface VariantInput`, after `inventoryOnHand?: number;` add:

```ts
  grams?: number;
  lengthMm?: number;
  widthMm?: number;
  heightMm?: number;
```

- [ ] **Step 2: Write the failing test**

Create `app/lib/catalog/__tests__/catalog-shipping-dims.server.test.ts`. This test drives the real `createProduct` against an in-memory Supabase fake and asserts the columns are written and that an invalid dimension throws:

```ts
/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory supabase fake */
import { describe, it, expect, vi, beforeEach } from "vitest";

const store: Record<string, any[]> = {};
const inserts: Array<{ table: string; rows: any }> = [];
function builder(table: string): any {
  const api: any = {
    select: () => api, eq: () => api, in: () => api, order: () => api,
    maybeSingle: async () => ({ data: (store[table] ?? [])[0] ?? null, error: null }),
    single: async () => ({ data: { id: `${table}-id` }, error: null }),
    insert: (rows: any) => {
      inserts.push({ table, rows });
      const chain: any = { select: () => chain, single: async () => ({ data: { id: `${table}-id` }, error: null }) };
      return chain;
    },
    update: () => api, delete: () => api,
    then: (r: (x: { data: any; error: null }) => unknown) => r({ data: store[table] ?? [], error: null }),
  };
  return api;
}
vi.mock("../../supabase.server", () => ({ getSupabase: () => ({ from: (t: string) => builder(t) }) }));
vi.mock("../project-sku-dim.server", () => ({ projectProductToSkuDim: async () => {} }));

let createProduct: typeof import("../catalog.server").createProduct;
beforeEach(async () => {
  inserts.length = 0;
  ({ createProduct } = await import("../catalog.server"));
});

const SHOP = "00000000-0000-0000-0000-000000000001";
const base = {
  title: "Tee", status: "active" as const,
  variants: [{ title: "S", grams: 500, lengthMm: 200, widthMm: 150, heightMm: 100 }],
};

describe("createProduct shipping dims", () => {
  it("persists grams + length/width/height_mm on the variant insert", async () => {
    await createProduct(SHOP, base as any);
    const v = inserts.find((i) => i.table === "variant_dim");
    expect(v).toBeTruthy();
    expect(v!.rows).toMatchObject({ grams: 500, length_mm: 200, width_mm: 150, height_mm: 100 });
  });

  it("throws before writing when a dimension is invalid", async () => {
    const bad = { ...base, variants: [{ title: "S", lengthMm: 0 }] };
    await expect(createProduct(SHOP, bad as any)).rejects.toThrow(/lengthMm/);
    expect(inserts.find((i) => i.table === "variant_dim")).toBeFalsy();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run app/lib/catalog/__tests__/catalog-shipping-dims.server.test.ts`
Expected: FAIL — columns not written / no validation throw.

- [ ] **Step 4: Implement — import the validator**

In `app/lib/catalog/catalog.server.ts`, add to the imports at the top:

```ts
import { validateVariantDims } from "./shipping-dims";
```

- [ ] **Step 5: Implement — validate + persist in `writeProductChildren` (create path)**

In `writeProductChildren`, inside the `for (const [i, v] of input.variants.entries())` loop, immediately BEFORE the `const { data: variant, error: vErr } = await sb.from("variant_dim").insert({...})` call, add:

```ts
    const dimCheck = validateVariantDims({ grams: v.grams, lengthMm: v.lengthMm, widthMm: v.widthMm, heightMm: v.heightMm });
    if (!dimCheck.ok) throw new Error(dimCheck.error);
```

Then in that same `.insert({ ... })` object, after `inventory_on_hand: v.inventoryOnHand ?? 0, position: i,` add:

```ts
        grams: v.grams ?? null,
        length_mm: v.lengthMm ?? null,
        width_mm: v.widthMm ?? null,
        height_mm: v.heightMm ?? null,
```

- [ ] **Step 6: Implement — validate + persist in `updateProduct` (`fields`)**

In `updateProduct`, inside the `for (const [i, v] of input.variants.entries())` loop, immediately BEFORE `const fields = {`, add:

```ts
    const dimCheck = validateVariantDims({ grams: v.grams, lengthMm: v.lengthMm, widthMm: v.widthMm, heightMm: v.heightMm });
    if (!dimCheck.ok) throw new Error(dimCheck.error);
```

Then in the `fields` object, after `inventory_on_hand: v.inventoryOnHand ?? 0, position: i,` add:

```ts
      grams: v.grams ?? null,
      length_mm: v.lengthMm ?? null,
      width_mm: v.widthMm ?? null,
      height_mm: v.heightMm ?? null,
```

> Note: `grams`/dims are written from the draft, which round-trips them via `getProduct` (Task 4) + the editor (Task 5). Because the editor always carries the fetched values back, an edit does not null a previously-imported `grams` — the same round-trip contract the price/stock fields rely on.

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run app/lib/catalog/__tests__/catalog-shipping-dims.server.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 8: Commit**

```bash
git add app/lib/catalog/types.ts app/lib/catalog/catalog.server.ts app/lib/catalog/__tests__/catalog-shipping-dims.server.test.ts
git commit -m "catalog: validate + persist variant shipping dims on create/update"
```

---

### Task 4: Read path — return dims from `getProduct`

**Files:**
- Modify: `app/lib/catalog/types.ts` (`ProductDetail.variants[]`)
- Modify: `app/lib/catalog/catalog.server.ts` (`getProduct` variant select + mapping)
- Test: extend `app/lib/catalog/__tests__/catalog-shipping-dims.server.test.ts`

**Interfaces:**
- Produces: `ProductDetail.variants[]` gains `grams: number | null; lengthMm: number | null; widthMm: number | null; heightMm: number | null`. `getProduct` selects and maps them.

- [ ] **Step 1: Add the DTO fields**

In `app/lib/catalog/types.ts`, inside `ProductDetail` → `variants: Array<{ ... }>`, after `inventoryOnHand: number;` add:

```ts
    grams: number | null;
    lengthMm: number | null;
    widthMm: number | null;
    heightMm: number | null;
```

- [ ] **Step 2: Write the failing test (append)**

Append to `app/lib/catalog/__tests__/catalog-shipping-dims.server.test.ts` a new `describe` that seeds a `variant_dim` row and asserts `getProduct` maps the columns. Add near the top-level (reuse the existing fake by seeding `store`):

```ts
describe("getProduct shipping dims", () => {
  it("maps grams + length/width/height_mm into the variant DTO", async () => {
    store["product_dim"] = [{ id: "p1", title: "Tee", status: "active", vendor: null, category: null, description: null, tags: [], updated_at: "t" }];
    store["variant_dim"] = [{ id: "v1", sku: "S", title: "S", retail_price_cents: 1999, unit_cost_cents: null, inventory_tracked: true, inventory_on_hand: 3, position: 0, grams: 500, length_mm: 200, width_mm: 150, height_mm: 100 }];
    const { getProduct } = await import("../catalog.server");
    const detail = await getProduct(SHOP, "p1");
    expect(detail!.variants[0]).toMatchObject({ grams: 500, lengthMm: 200, widthMm: 150, heightMm: 100 });
  });
});
```

(If the existing fake's `maybeSingle`/`then` do not return seeded rows for these tables, extend the fake minimally so `product_dim.maybeSingle()` returns `store.product_dim[0]` and `variant_dim` list reads return `store.variant_dim` — keep it consistent with Task 3's fake.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run app/lib/catalog/__tests__/catalog-shipping-dims.server.test.ts`
Expected: FAIL — DTO lacks the fields.

- [ ] **Step 4: Implement — extend the `getProduct` variant select**

In `getProduct`, change the `variant_dim` select from:

```ts
    sb.from("variant_dim").select("id, sku, title, retail_price_cents, unit_cost_cents, inventory_tracked, inventory_on_hand, position").eq("product_id", productId).order("position"),
```

to (add the four columns):

```ts
    sb.from("variant_dim").select("id, sku, title, retail_price_cents, unit_cost_cents, inventory_tracked, inventory_on_hand, position, grams, length_mm, width_mm, height_mm").eq("product_id", productId).order("position"),
```

- [ ] **Step 5: Implement — map the fields**

In the `getProduct` return, inside `variants: (variants ?? []).map((v: Record<string, unknown>) => ({ ... }))`, after `inventoryOnHand: Number(v.inventory_on_hand ?? 0),` add:

```ts
      grams: (v.grams as number | null) ?? null,
      lengthMm: (v.length_mm as number | null) ?? null,
      widthMm: (v.width_mm as number | null) ?? null,
      heightMm: (v.height_mm as number | null) ?? null,
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run app/lib/catalog/__tests__/catalog-shipping-dims.server.test.ts`
Expected: PASS (all cases).

- [ ] **Step 7: Commit**

```bash
git add app/lib/catalog/types.ts app/lib/catalog/catalog.server.ts app/lib/catalog/__tests__/catalog-shipping-dims.server.test.ts
git commit -m "catalog: return variant shipping dims from getProduct"
```

---

### Task 5: Editor UI — weight + dimension inputs + incomplete warning

**Files:**
- Modify: `app/lib/dashboard/client.ts` (`VariantDraft`)
- Modify: `app/components/dashboard/screens/ProductEditor.tsx`
- Test: none new (UI); verified by typecheck + build + the controller's visual QA in Task 6.

**Interfaces:**
- Consumes: `isShippingComplete` (Task 2), `ProductDetail` shipping fields (Task 4).
- Produces: `VariantDraft` gains `grams?: number; lengthMm?: number; widthMm?: number; heightMm?: number`; the editor renders inputs bound via `setVariantField`.

- [ ] **Step 1: Add the draft type fields**

In `app/lib/dashboard/client.ts`, inside `interface VariantDraft`, after `inventoryOnHand?: number;` add:

```ts
  grams?: number;
  lengthMm?: number;
  widthMm?: number;
  heightMm?: number;
```

- [ ] **Step 2: Ensure the load mapping carries the fields**

In `ProductEditor.tsx`, find where a fetched product's variants are loaded into the `variants` state (the mapping from the fetched `ProductDetail`/VM into `VariantDraft[]`, near where `retailPriceCents`, `inventoryOnHand`, `optionValues` are copied for each existing variant). Add the four fields to that per-variant object so an edit round-trips them, e.g. alongside the existing copies:

```ts
      grams: v.grams ?? undefined,
      lengthMm: v.lengthMm ?? undefined,
      widthMm: v.widthMm ?? undefined,
      heightMm: v.heightMm ?? undefined,
```

(Match the surrounding style; the source `v` is the fetched variant carrying the Task-4 fields. If the editor currently spreads the fetched variant, no change is needed — verify the fields survive.)

- [ ] **Step 3: Add the import**

At the top of `ProductEditor.tsx`, add:

```ts
import { isShippingComplete } from "~/lib/catalog/shipping-dims";
```

- [ ] **Step 4: Render the shipping sub-row + warning**

In the variant list, inside the `{variants.map((v, i) => ( ... ))}` block, replace the closing `</div>` of each variant row so a second row of shipping inputs (and an incomplete warning) renders beneath the main row. Concretely, change the per-variant wrapper to a vertical stack: wrap the existing horizontal row and add the shipping row after it. Insert, immediately after the main row's closing `</div>` (the one that closes the `display: "flex"` row started at the `key={i}` div) and before the `))}`:

```tsx
                  <div style={{ display: "flex", gap: 8, alignItems: "center", paddingLeft: 4 }}>
                    <span className="cd-caption" style={{ width: 66 }}>Shipping</span>
                    <input
                      className="cd-input tabular-nums" type="number" min="1" step="1" inputMode="numeric"
                      aria-label={`Weight in grams for ${variantLabel(v)}`} placeholder="Weight g"
                      value={v.grams ?? ""}
                      onChange={(e) => setVariantField(i, { grams: e.target.value === "" ? undefined : Math.trunc(Number(e.target.value)) || undefined })}
                      style={{ width: 96, textAlign: "right" }}
                    />
                    {(["lengthMm", "widthMm", "heightMm"] as const).map((axis) => (
                      <input
                        key={axis}
                        className="cd-input tabular-nums" type="number" min="1" step="1" inputMode="numeric"
                        aria-label={`${axis.replace("Mm", "")} in millimetres for ${variantLabel(v)}`}
                        placeholder={`${axis.replace("Mm", "").toUpperCase()} mm`}
                        value={v[axis] ?? ""}
                        onChange={(e) => setVariantField(i, { [axis]: e.target.value === "" ? undefined : Math.trunc(Number(e.target.value)) || undefined })}
                        style={{ width: 84, textAlign: "right" }}
                      />
                    ))}
                    {!isShippingComplete({ grams: v.grams, lengthMm: v.lengthMm, widthMm: v.widthMm, heightMm: v.heightMm }) && (
                      <span className="cd-caption" style={{ color: "var(--cd-warning, #b45309)" }}>
                        Incomplete — rates estimated
                      </span>
                    )}
                  </div>
```

(The `key={i}` wrapper must contain BOTH the main row and this shipping row; if the current wrapper is a single flex row, change its wrapper to `style={{ display: "flex", flexDirection: "column", gap: 6 }}` and nest the original inputs in an inner `display:"flex"` row so the shipping row sits beneath. Keep the flat cd-input style; do not introduce new CSS files.)

- [ ] **Step 5: Verify typecheck + build**

Run: `npm run typecheck` → exit 0.
Run: `npm run build` → exit 0.
Expected: no type errors; the editor compiles.

- [ ] **Step 6: Commit**

```bash
git add app/lib/dashboard/client.ts app/components/dashboard/screens/ProductEditor.tsx
git commit -m "dashboard/ProductEditor: variant weight + dimension inputs with incomplete-shipping warning"
```

---

### Task 6: Migration apply + full gate + visual QA

**Files:** none new — verification only.

- [ ] **Step 1: Apply the migration to Supabase (controller)**

Apply `20260630180000_variant_dimensions.sql` via the Supabase MCP and confirm `variant_dim` now has `length_mm`, `width_mm`, `height_mm` (via `information_schema.columns`). Check `get_advisors` (security) shows no new ERROR.

- [ ] **Step 2: Run the full owned/catalog test suite**

Run: `npx vitest run app/lib/catalog`
Expected: PASS — includes `shipping-dims` (9) + `catalog-shipping-dims.server` and the pre-existing catalog tests, no regressions.

- [ ] **Step 3: Full pre-commit gate (CLAUDE.md)**

Run in order, paste each result (rule 12):

```bash
npm run typecheck   # exit 0
npm run lint        # exit 0, no warnings on touched files
npm run build       # exit 0 (Remix + Vite + verify-client-bundle)
```

- [ ] **Step 4: `/code-review` on the working tree**

Resolve blockers; downgrade nits with a one-line justification.

- [ ] **Step 5: Visual QA (controller)**

The `ProductEditor` shipping sub-row is a new browser-visible UI on a design-sensitive surface. The controller runs the app (or screenshots the editor) to confirm the weight/dimension inputs and warning render cleanly in the flat dashboard style before the branch is finished. Note any polish follow-ups.

- [ ] **Step 6: Patch sanity**

`git diff --stat origin/main` and `git diff --check` clean; no stray `console.log`, `.only`, provenance markers; the engine (`app/lib/shipping/*`, `app/lib/commerce/*`) is untouched.

---

## Hand-off (not in this plan)

`toParcelDims` (Task 2) is the read contract for Eric's quote engine. Wiring the engine's `ShippingQuoteLine` builder to call it (replacing the estimated parcel, clearing `lowConfidence` when a variant is shipping-complete) is Eric's change in `app/lib/commerce/*` / `app/lib/shipping/*`. Leave this as an explicit hand-off — do not modify the engine here.

## Self-Review

**Spec coverage:**
- `length/width/height_mm` columns → Task 1. ✓
- Metric-integer storage → Global Constraints + Task 1. ✓
- Format-strict + presence-soft validation → Task 2 (`validateVariantDims`, `isShippingComplete`) + Task 3 (write-boundary throw). ✓
- Editor weight + dim inputs + incomplete warning → Task 5. ✓
- Read exposure (`getProduct`) → Task 4. ✓
- metric→imperial converter for the engine → Task 2 (`toParcelDims`). ✓
- Engine NOT modified / hand-off → Hand-off section + Global Constraints. ✓
- Origin/restrictions/advanced deferred → not built. ✓
- Dashboard-only parity note → Global Constraints. ✓

**Placeholder scan:** No TBD/TODO; every code + test step shows full code. The `<ts>` is a concrete filename (`20260630180000`). ✓

**Type consistency:** `grams`/`lengthMm`/`widthMm`/`heightMm` (camelCase) on `VariantInput`/`VariantDraft`/`ProductDetail`; `grams`/`length_mm`/`width_mm`/`height_mm` (snake_case) as DB columns; `VariantShippingFields`/`validateVariantDims`/`isShippingComplete`/`toParcelDims`/`ParcelDims` used identically across tasks. ✓

**One flagged risk:** Task 5 Step 2/4 depend on the exact current `ProductEditor` structure (the per-variant wrapper). The implementer must read the file and adapt the wrapper to a column stack if it is currently a single flex row — the plan gives the target markup and the adaptation rule, but this is the one task requiring judgment against live JSX. Visual QA (Task 6 Step 5) is the backstop.
