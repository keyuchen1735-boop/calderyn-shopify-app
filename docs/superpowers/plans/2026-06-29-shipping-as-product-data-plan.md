# Shipping-as-Product-Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store the rate-critical shipping attributes on the owned catalog (per-variant size + weight + rules, per-location ship-from address), validate them at write, and expose the exact `Parcel`/`Address` shapes Eric's merged quote engine reads — so checkout returns a real shipping rate.

**Architecture:** A `variant_shipping` table (1:1 with `variant_dim`) holds the per-variant shipping fields; `location_dim` gains a full ship-from address. The Slice 1 catalog write path persists/reads them; the editor gets a "Shipping" section. Two read helpers (`buildParcel`, `originAddress`) + `canShipTo` produce Eric's exact types — the clean doorway between the halves.

**Tech Stack:** Postgres (Supabase) migration, `@supabase/supabase-js`, the Slice 1 catalog layer + Slice 1/2 dashboard screens, vitest. Imports Eric's types from `~/lib/ship-cost/adapters/rate-quote` (merged, on `origin/main`). Depends on Slice 1 + Slice 2 being built.

## Global Constraints

- TypeScript only; `tsc --noEmit` authoritative; no `any` without justification.
- **Import Eric's `Address`/`Parcel` types directly** from `~/lib/ship-cost/adapters/rate-quote` — never re-declare them, so a change on his side is a compile error here, not a silent mismatch.
- Store canonical **metric** (grams, mm); convert to oz/inches in **one place** (`buildParcel`) with a unit test.
- Validation fails **visibly** (rule 12): a physical variant can't go `active` without weight + all dims — a missing dimension is a clear error, never a silent 0.
- Migration in BOTH `supabase/migrations/` and `tests/engine/schema/migrations/`; new table gets `enable row level security`.
- Pre-commit gate: `npm run typecheck` → `npm run lint` → `npm run build` (exit 0); `npx vitest run` green.

---

### Task 1: Migration — `variant_shipping` + location address + backfill

**Files:**
- Create: `supabase/migrations/20260629140000_variant_shipping.sql` (+ engine copy)

**Interfaces:**
- Produces: `variant_shipping(variant_id pk→variant_dim, shop_id, weight_grams, length_mm, width_mm, height_mm, requires_shipping, restricted_countries text[], handling_days, signature_required, updated_at)`; `location_dim` + `street1`, `street2`, `postal_code`.

- [ ] **Step 1: Write the migration**

```sql
create table if not exists public.variant_shipping (
  variant_id uuid primary key references public.variant_dim(id) on delete cascade,
  shop_id uuid not null references public.shops(id) on delete cascade,
  weight_grams int not null default 0 check (weight_grams >= 0),
  length_mm int check (length_mm is null or length_mm > 0),
  width_mm int check (width_mm is null or width_mm > 0),
  height_mm int check (height_mm is null or height_mm > 0),
  requires_shipping boolean not null default true,
  restricted_countries text[] not null default '{}',
  handling_days int not null default 0 check (handling_days >= 0),
  signature_required boolean not null default false,
  updated_at timestamptz not null default now()
);
create index if not exists variant_shipping_shop_idx on public.variant_shipping(shop_id);
alter table public.variant_shipping enable row level security;

-- Backfill a row per variant from the weight + requires_shipping already on variant_dim.
insert into public.variant_shipping (variant_id, shop_id, weight_grams, requires_shipping)
select v.id, v.shop_id, coalesce(v.grams, 0), coalesce(v.requires_shipping, true)
from public.variant_dim v
on conflict (variant_id) do nothing;

-- Location ship-from address (city/region/country already exist; add the rest).
alter table public.location_dim add column if not exists street1 text;
alter table public.location_dim add column if not exists street2 text;
alter table public.location_dim add column if not exists postal_code text;
```

- [ ] **Step 2: Apply locally + verify** (`psql -f`; `\d variant_shipping`; confirm backfill count == variant count). **Commit.**

```bash
git add supabase/migrations/20260629140000_variant_shipping.sql tests/engine/schema/migrations/20260629140000_variant_shipping.sql
git commit -m "feat(shipping): variant_shipping table + location ship-from address"
```

---

### Task 2: Shipping validation at the catalog write boundary

**Files:**
- Modify: `app/lib/catalog/types.ts` (extend `VariantInput` with shipping fields)
- Modify: `app/lib/catalog/validate.ts` (require weight+dims for active physical variants)
- Test: `app/lib/catalog/__tests__/validate-shipping.test.ts`

**Interfaces:**
- Consumes: the Slice 1 `validateProductInput`.
- Produces: `VariantInput` gains `weightGrams?`, `lengthMm?`, `widthMm?`, `heightMm?`, `requiresShipping?`, `handlingDays?`, `signatureRequired?`, `restrictedCountries?: string[]`; `validateProductInput` rejects an `active` product whose physical variants lack weight+dims (code `incomplete_shipping`).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { validateProductInput } from "../validate";

const base = { title: "Mug", status: "active" as const };

describe("shipping validation", () => {
  it("rejects an ACTIVE physical variant missing dimensions", () => {
    const r = validateProductInput({ ...base, variants: [{ sku: "M", requiresShipping: true, weightGrams: 340 }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("incomplete_shipping");
  });
  it("allows an ACTIVE physical variant with weight + dims", () => {
    const r = validateProductInput({ ...base, variants: [{ sku: "M", requiresShipping: true, weightGrams: 340, lengthMm: 127, widthMm: 127, heightMm: 102 }] });
    expect(r.ok).toBe(true);
  });
  it("allows a digital (requires_shipping=false) variant with no dims", () => {
    const r = validateProductInput({ ...base, variants: [{ sku: "D", requiresShipping: false }] });
    expect(r.ok).toBe(true);
  });
  it("allows a DRAFT physical variant with no dims (only active is gated)", () => {
    const r = validateProductInput({ ...base, status: "draft", variants: [{ sku: "M", requiresShipping: true }] });
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run → fail.** `npx vitest run app/lib/catalog/__tests__/validate-shipping.test.ts`

- [ ] **Step 3: Extend `types.ts` + `validate.ts`**

Add to `VariantInput` (types.ts): `weightGrams?: number; lengthMm?: number; widthMm?: number; heightMm?: number; requiresShipping?: boolean; handlingDays?: number; signatureRequired?: boolean; restrictedCountries?: string[];`

In `validateProductInput` (validate.ts), after building `variants`, parse those fields and add the gate:

```typescript
const ISO2 = /^[A-Za-z]{2}$/;
for (const v of variants) {
  if (v.restrictedCountries?.some((c) => !ISO2.test(c))) return { ok: false, code: "invalid_country" };
  // Only ACTIVE products must ship-complete; drafts may be incomplete.
  const physical = v.requiresShipping !== false;
  if (status === "active" && physical) {
    if (!(v.weightGrams && v.weightGrams > 0) || !(v.lengthMm && v.lengthMm > 0) || !(v.widthMm && v.widthMm > 0) || !(v.heightMm && v.heightMm > 0)) {
      return { ok: false, code: "incomplete_shipping" };
    }
  }
}
```
(Parse the new fields into each variant in the existing `variants.map(...)`, mirroring how `inventoryOnHand` etc. are parsed.)

- [ ] **Step 4: Run → pass. Commit.**

```bash
git add app/lib/catalog/types.ts app/lib/catalog/validate.ts app/lib/catalog/__tests__/validate-shipping.test.ts
git commit -m "feat(shipping): require weight+dims before a physical product goes live"
```

---

### Task 3: Persist + read shipping in the catalog layer

**Files:**
- Modify: `app/lib/catalog/catalog.server.ts` (write `variant_shipping` in create/update; return it in `getProduct`)
- Test: `app/lib/catalog/__tests__/catalog-shipping.server.test.ts`

**Interfaces:**
- Produces: `writeProductChildren` / `updateProduct`'s per-variant write also upserts a `variant_shipping` row; `getProduct`'s variants gain the shipping fields.

- [ ] **Step 1: Write the failing test** (mock supabase; assert a `variant_shipping` upsert with the variant's shipping fields on create)

```typescript
import { describe, it, expect, vi } from "vitest";
const upserts: Record<string, unknown[]> = {};
vi.mock("../project-sku-dim.server", () => ({ projectProductToSkuDim: vi.fn() }));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: (t: string) => ({
      insert: (rows: unknown) => { (upserts[t] ??= []).push(rows); return { select: () => ({ single: () => Promise.resolve({ data: { id: t === "product_dim" ? "p1" : "v1" }, error: null }) }) }; },
      upsert: (rows: unknown) => { (upserts[t] ??= []).push(rows); return Promise.resolve({ error: null }); },
    }),
  }),
}));
describe("createProduct shipping", () => {
  it("writes a variant_shipping row", async () => {
    const { createProduct } = await import("../catalog.server");
    await createProduct("shop1", { title: "Mug", status: "draft", variants: [{ sku: "M", weightGrams: 340, lengthMm: 127, widthMm: 127, heightMm: 102 }] } as never);
    expect(JSON.stringify(upserts["variant_shipping"])).toContain("340");
  });
});
```

- [ ] **Step 2: Run → fail. Step 3: Wire it in.** In the per-variant write (inside `writeProductChildren` and `updateProduct`'s variant loop), after the variant row is created/updated, upsert its `variant_shipping`:

```typescript
await sb.from("variant_shipping").upsert({
  variant_id: variantId, shop_id: shopId,
  weight_grams: v.weightGrams ?? 0,
  length_mm: v.lengthMm ?? null, width_mm: v.widthMm ?? null, height_mm: v.heightMm ?? null,
  requires_shipping: v.requiresShipping ?? true,
  restricted_countries: v.restrictedCountries ?? [],
  handling_days: v.handlingDays ?? 0,
  signature_required: v.signatureRequired ?? false,
  updated_at: new Date().toISOString(),
}, { onConflict: "variant_id" });
```
In `getProduct`, join `variant_shipping` and map its fields onto each returned variant.

- [ ] **Step 4: Run → pass. Commit.**

```bash
git add app/lib/catalog/catalog.server.ts app/lib/catalog/__tests__/catalog-shipping.server.test.ts
git commit -m "feat(shipping): persist + read variant_shipping in the catalog layer"
```

---

### Task 4: The seam helpers (`buildParcel` / `originAddress` / `canShipTo`) — the one with the unit test

**Files:**
- Create: `app/lib/shipping/parcel.server.ts`
- Test: `app/lib/shipping/__tests__/parcel.server.test.ts`

**Interfaces:**
- Consumes: `getSupabase`; Eric's `Parcel`/`Address` types from `~/lib/ship-cost/adapters/rate-quote`.
- Produces: `buildParcel(variantId): Promise<Parcel>`, `originAddress(locationId): Promise<Address>`, `canShipTo(variantId, destCountryIso2): Promise<boolean>`.

- [ ] **Step 1: Write the failing test (the conversion is the point)**

```typescript
import { describe, it, expect, vi } from "vitest";
const shipping = { weight_grams: 340, length_mm: 127, width_mm: 127, height_mm: 102, restricted_countries: ["CA"] };
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: shipping, error: null }) }) }) }) }),
}));
describe("buildParcel", () => {
  it("converts grams→oz and mm→inches", async () => {
    const { buildParcel } = await import("../parcel.server");
    const p = await buildParcel("v1");
    expect(p.weightOz).toBeCloseTo(11.99, 1); // 340g
    expect(p.lengthIn).toBeCloseTo(5, 2);      // 127mm
    expect(p.heightIn).toBeCloseTo(4.02, 2);   // 102mm
  });
  it("canShipTo is false for a restricted country", async () => {
    const { canShipTo } = await import("../parcel.server");
    expect(await canShipTo("v1", "ca")).toBe(false);
    expect(await canShipTo("v1", "us")).toBe(true);
  });
});
```

- [ ] **Step 2: Run → fail. Step 3: Write `parcel.server.ts`**

```typescript
// app/lib/shipping/parcel.server.ts
// The doorway between the owned catalog (our shipping data) and Eric's quote
// engine. Returns HIS exact types so his checkout never reads our tables.
import { getSupabase } from "../supabase.server";
import type { Parcel, Address } from "~/lib/ship-cost/adapters/rate-quote";

const G_TO_OZ = 0.0352739619;
const MM_TO_IN = 1 / 25.4;

export async function buildParcel(variantId: string): Promise<Parcel> {
  const { data, error } = await getSupabase()
    .from("variant_shipping")
    .select("weight_grams, length_mm, width_mm, height_mm")
    .eq("variant_id", variantId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`no shipping data for variant ${variantId}`);
  return {
    lengthIn: Number(data.length_mm ?? 0) * MM_TO_IN,
    widthIn: Number(data.width_mm ?? 0) * MM_TO_IN,
    heightIn: Number(data.height_mm ?? 0) * MM_TO_IN,
    weightOz: Number(data.weight_grams ?? 0) * G_TO_OZ,
  };
}

export async function originAddress(locationId: string): Promise<Address> {
  const { data, error } = await getSupabase()
    .from("location_dim")
    .select("name, street1, street2, city, region, postal_code, country")
    .eq("id", locationId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`location ${locationId} not found`);
  return {
    name: data.name ?? undefined,
    street1: String(data.street1 ?? ""),
    street2: data.street2 ?? undefined,
    city: String(data.city ?? ""),
    state: String(data.region ?? ""),
    zip: String(data.postal_code ?? ""),
    country: String(data.country ?? "US"),
  };
}

export async function canShipTo(variantId: string, destCountryIso2: string): Promise<boolean> {
  const { data, error } = await getSupabase()
    .from("variant_shipping")
    .select("restricted_countries")
    .eq("variant_id", variantId)
    .maybeSingle();
  if (error) throw error;
  const restricted = ((data?.restricted_countries as string[]) ?? []).map((c) => c.toUpperCase());
  return !restricted.includes(destCountryIso2.toUpperCase());
}
```

- [ ] **Step 4: Run → pass.** (If `~/lib/ship-cost/adapters/rate-quote` isn't present in the branch, this is the signal the branch isn't off the merged `origin/main` — rebase before continuing.) **Commit.**

```bash
git add app/lib/shipping/parcel.server.ts app/lib/shipping/__tests__/parcel.server.test.ts
git commit -m "feat(shipping): seam helpers (buildParcel/originAddress/canShipTo) for the quote engine"
```

---

### Task 5: UI — Shipping section in the editor + address in location settings

**Files:**
- Modify: `app/components/dashboard/screens/ProductEditor.tsx` (a "Shipping" block per variant)
- Modify: `app/components/dashboard/screens/Locations.tsx` (Slice 2) — add address fields
- Modify: `app/lib/dashboard/client.ts` — `ProductDraft`/`VariantDraft` + `LocationVM` carry the new fields

**Interfaces:**
- Consumes: the catalog save/load (carrying the new fields) + the locations update.
- Behavior: per variant — inputs for L/W/H (mm) + weight (g) + a "physical product" toggle + handling days + signature + restricted-countries; a save attempt that fails the `incomplete_shipping` validation surfaces a clear message naming the missing field. Locations screen adds street/city/state/zip/country.

- [ ] **Step 1: Extend the client types** — add the shipping fields to `VariantDraft` and the address fields to `LocationVM` in `client.ts` (so they round-trip through `saveProduct` / `updateLocation`).

- [ ] **Step 2: Add the Shipping block to `ProductEditor.tsx`** — under each variant (or a per-product "Shipping" card), inputs bound to the variant's shipping fields; on save failure with code `incomplete_shipping`, toast "Add size + weight before going live." (Structure follows the existing variant grid; `cd-*` classes per the sibling screens.)

- [ ] **Step 3: Add address fields to `Locations.tsx`** — street1/street2/city/state(region)/postal_code/country inputs that save via `updateLocation` (extend the route's PATCHABLE fields to include them).

- [ ] **Step 4: Verify** `npm run typecheck && npm run build` → exit 0. **Commit.**

```bash
git add app/components/dashboard/screens/ProductEditor.tsx app/components/dashboard/screens/Locations.tsx app/lib/dashboard/client.ts app/routes/dashboard.api.catalog.locations.$id.tsx
git commit -m "feat(shipping): editor Shipping section + location ship-from address fields"
```

---

### Task 6: Full gate

- [ ] **Step 1:** `npm run typecheck` → `npm run lint` → `npm run build` → `npx vitest run`, all exit 0 (paste results). **Step 2:** commit any fixups.

```bash
git add -A && git commit -m "chore(shipping): green gate for shipping-as-product-data"
```

---

## Self-Review

**Spec coverage:**
- Per-variant size/weight/rules → Task 1 (`variant_shipping`) + Task 3 (persist) + Task 5 (UI). ✅
- Per-location ship-from address → Task 1 + Task 5. ✅
- Validation (active physical needs weight+dims; digital skips; draft allowed) → Task 2. ✅
- Seam helpers in Eric's exact types + unit conversion tested → Task 4. ✅
- `canShipTo` restriction → Task 4. ✅
- Deferred (hazmat/freight/customs) → not in any task. ✅

**Placeholder scan:** none — Task 5 (UI) gives structure + the exact client/route wiring, styling per the sibling screens (codebase convention); the data/logic (migration, validation, helpers, conversion) is in full.

**Type consistency:** the new `VariantInput`/`VariantDraft` shipping fields are written by Task 2/3 and read by Task 5; `buildParcel`/`originAddress` use Eric's imported `Parcel`/`Address` (Task 4) — a drift there is a compile error, by design. `weight_grams` is seeded from `variant_dim.grams` (Task 1) and is the authoritative weight the helper converts.

**Dependency note:** Task 4 imports from `~/lib/ship-cost/adapters/rate-quote` (Eric's merged code) — the branch must be off the current `origin/main` that contains it.
