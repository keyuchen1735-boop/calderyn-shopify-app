# Store-Action Executor (Owned Writes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-point the three store actions (`adjust_price`, `reallocate_inventory`, `discontinue_sku`) and their undo branches from Shopify writes to owned-table writes (Slice 1 catalog + Slice 2 inventory), keeping the audit/idempotency/calibration/graduation machinery unchanged.

**Architecture:** A surgical body-swap. Each executor keeps its caller seam (same `action_kind`, same audit tail) and changes only resolve + write: resolve targets by owned ids (`variant_dim`/`product_dim`/`location_dim.id`), write via owned primitives (`setVariantPrice`, `setProductStatus`, `createTransfer`). The undo branches swap the same way and no longer need a Shopify admin client.

**Tech Stack:** TypeScript, `@supabase/supabase-js`, vitest. Depends on Slice 1 (`catalog.server.ts`: `setProductStatus`, `projectProductToSkuDim`) + Slice 2 (`engine.server.ts`: `createTransfer`).

## Global Constraints

- TypeScript only; `tsc --noEmit` authoritative; no `any` without written justification.
- **No Shopify API calls** in any of these executors or undo branches after this change.
- The shared audit tail (`insertAuditWithIdempotency`, `priorExecutionForKey` in `execute.server.ts`), calibration, graduation, and the autopilot loop are **not modified** — only the resolve + write inside each store executor.
- **Undo needs a true pre-state read BEFORE the write** (old price, old status, the transfer plan) — each executor captures its baseline first.
- Resolve targets by **owned ids** (`variant_dim.id` = `sku_dim.id`; `product_dim.id`; `location_dim.id`), never Shopify GIDs.
- Pre-commit gate before committing: `npm run typecheck` → `npm run lint` → `npm run build` (exit 0); `npx vitest run` green.

---

### Task 1: Owned `setVariantPrice` in the catalog layer

**Files:**
- Modify: `app/lib/catalog/catalog.server.ts` (append)
- Test: `app/lib/catalog/__tests__/catalog-set-price.server.test.ts`

**Interfaces:**
- Consumes: `getSupabase`; `projectProductToSkuDim` (Slice 1).
- Produces: `setVariantPrice(shopId: string, variantId: string, priceCents: number): Promise<{ priorPriceCents: number | null }>` — reads the prior price (for the caller's undo baseline), writes `variant_dim.retail_price_cents`, re-projects `sku_dim`, returns the prior price.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
const project = vi.fn().mockResolvedValue(undefined);
vi.mock("../project-sku-dim.server", () => ({ projectProductToSkuDim: project }));
const maybeSingle = vi.fn().mockResolvedValue({ data: { product_id: "p1", retail_price_cents: 1999 }, error: null });
const update = vi.fn(() => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle }) }) }), update }) }),
}));
beforeEach(() => { project.mockClear(); });

describe("setVariantPrice", () => {
  it("writes the new price, returns the prior, and re-projects", async () => {
    const { setVariantPrice } = await import("../catalog.server");
    const r = await setVariantPrice("shop1", "v1", 2499);
    expect(r).toEqual({ priorPriceCents: 1999 });
    expect(project).toHaveBeenCalledWith("p1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/catalog/__tests__/catalog-set-price.server.test.ts`
Expected: FAIL — `setVariantPrice` not exported.

- [ ] **Step 3: Append the function to `catalog.server.ts`**

```typescript
export async function setVariantPrice(shopId: string, variantId: string, priceCents: number): Promise<{ priorPriceCents: number | null }> {
  const sb = getSupabase();
  const { data: v, error } = await sb
    .from("variant_dim")
    .select("product_id, retail_price_cents")
    .eq("shop_id", shopId).eq("id", variantId)
    .maybeSingle();
  if (error) throw error;
  if (!v) throw new Error(`variant ${variantId} not found for shop`);
  const priorPriceCents = v.retail_price_cents == null ? null : Number(v.retail_price_cents);

  const { error: upErr } = await sb
    .from("variant_dim")
    .update({ retail_price_cents: priceCents, updated_at: new Date().toISOString() })
    .eq("shop_id", shopId).eq("id", variantId);
  if (upErr) throw upErr;

  await projectProductToSkuDim(String(v.product_id));
  return { priorPriceCents };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/catalog/__tests__/catalog-set-price.server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/catalog/catalog.server.ts app/lib/catalog/__tests__/catalog-set-price.server.test.ts
git commit -m "feat(catalog): owned setVariantPrice (single-variant price + reproject)"
```

---

### Task 2: Re-point `adjust_price` to owned read/write

**Files:**
- Modify: `app/lib/actions/adjust-price.server.ts`
- Test: `app/lib/actions/__tests__/adjust-price.server.test.ts` (update/create)

**Interfaces:**
- Consumes: owned `setVariantPrice` (Task 1); drops `readVariantPrice`/`setVariantPrice` from `../shopify/price.server`.
- Produces: same `executeAdjustPriceAlertAction` signature minus the `admin` dependency. Resolution returns owned ids.

- [ ] **Step 1: Replace `resolveSkuVariant` to read the owned variant**

```typescript
export interface ResolvedSkuVariant { variantId: string; productId: string; priceCents: number | null }

export async function resolveSkuVariant(sb: SupabaseClient, shopId: string, skuCode: string): Promise<ResolvedSkuVariant | null> {
  const { data, error } = await sb
    .from("variant_dim")
    .select("id, product_id, retail_price_cents")
    .eq("shop_id", shopId).eq("sku", skuCode)
    .maybeSingle();
  if (error) throw error;
  if (!data?.id) return null;
  return { variantId: String(data.id), productId: String(data.product_id), priceCents: data.retail_price_cents == null ? null : Number(data.retail_price_cents) };
}
```

- [ ] **Step 2: Swap the read + write inside `executeAdjustPriceAlertAction`**

Remove the `admin` param and the `readVariantPrice`/`setVariantPrice`(Shopify) imports. Replace the "read current price" block (the `readVariantPrice` try/catch) with the owned price from resolve:

```typescript
const target = await resolveSkuVariant(sb, shopId, alert.sku);
if (!target || target.priceCents == null) {
  throw new CalderynError({ code: "sku_not_found", status: 422, message: "This SKU has no owned variant/price to change." });
}
const current = { priceCents: target.priceCents };  // owned current price anchors suggestion + cap
```

Replace the "Apply the price on Shopify" block with the owned write:

```typescript
let applied: { priceCents: number };
try {
  await setVariantPrice(shopId, target.variantId, finalPriceCents);  // owned (Task 1)
  applied = { priceCents: finalPriceCents };
} catch (err) {
  throw new CalderynError({ code: "action_failed", status: 502, message: err instanceof Error ? err.message : "Price update failed." });
}
```

Update `params` to owned ids + the prior price for undo:

```typescript
const params: Record<string, unknown> = {
  target: alert.sku, sku: alert.sku, sku_id: target.variantId, variant_id: target.variantId, product_id: target.productId,
  prior_price_cents: current.priceCents, new_price_cents: applied.priceCents, capped, estimate_cents: alert.dollar_impact,
};
```

(Import the owned `setVariantPrice` from `~/lib/catalog/catalog.server`. `getCurrentUnitCostCents` for the below-cost floor stays.)

- [ ] **Step 3: Update the test** to mock the owned `~/lib/catalog/catalog.server` `setVariantPrice` (not the Shopify one) and assert no Shopify import is used; the suggestion/cap/below-cost branches stay.

```typescript
// key assertions:
//  - setVariantPrice (owned) called with (shopId, variantId, finalPriceCents)
//  - params.prior_price_cents === the owned current price
//  - no call into ~/lib/shopify/price.server
```

- [ ] **Step 4: Run + verify**

Run: `npx vitest run app/lib/actions/__tests__/adjust-price.server.test.ts && npm run typecheck`
Expected: PASS; typecheck clean (fix any remaining `admin`-param callers — the gateway in `alert-action.server.ts` / dashboard route stops passing `admin` to this executor).

- [ ] **Step 5: Commit**

```bash
git add app/lib/actions/adjust-price.server.ts app/lib/actions/__tests__/adjust-price.server.test.ts
git commit -m "feat(actions): adjust_price writes the owned variant price (no Shopify)"
```

---

### Task 3: Re-point `reallocate_inventory` to the owned transfer

**Files:**
- Modify: `app/lib/actions/inventory-relocate.server.ts` (merchant-page path)
- Modify: `app/lib/actions/alert-action.server.ts` (alert-driven path — the `inventoryAdjustQuantitiesForShop` call near line 109)
- Test: `app/lib/actions/__tests__/inventory-relocate.server.test.ts` (update)

**Interfaces:**
- Consumes: Slice 2 `createTransfer(shopId, variantId, fromLocationId, toLocationId, qty, "instant")`; reads availability from `inventory_balance`.
- Produces: both paths resolve owned `location_dim.id` (not GIDs) and record owned ids in `params`.

- [ ] **Step 1: Swap `executeInventoryRelocation`'s resolve + write**

The input's `fromLocationId`/`toLocationId` become owned `location_dim.id` (the new inventory UI passes these). Resolve locations by id; read availability from `inventory_balance`; write via `createTransfer`:

```typescript
// 4. Validate location ownership (by owned id now).
const { data: locs, error: lErr } = await sb.from("location_dim").select("id, name, active").eq("shop_id", shopId).in("id", [input.fromLocationId, input.toLocationId]);
if (lErr) throw lErr;
const rows = (locs ?? []) as Array<{ id: string; name: string; active: boolean }>;
const from = rows.find((l) => l.id === input.fromLocationId);
const to = rows.find((l) => l.id === input.toLocationId);
if (!from || !to) throw new RelocationError("INVALID_TRANSFER_PLAN", "Location does not belong to this shop.");
if (!to.active) throw new RelocationError("INVALID_TRANSFER_PLAN", "The destination location is inactive.");

// 5. Fresh availability from the owned balance.
const { data: bal } = await sb.from("inventory_balance").select("available").eq("shop_id", shopId).eq("variant_id", input.skuId).eq("location_id", from.id).maybeSingle();
const fromAvailable = Number(bal?.available ?? 0);
if (input.quantity > fromAvailable) throw new RelocationError("QTY_EXCEEDS_AVAILABLE", `Only ${fromAvailable} unit${fromAvailable === 1 ? "" : "s"} available at ${from.name}.`);

// 6. Owned transfer (instant). createTransfer writes the inventory ledger + projects level-fact.
let outcome: ExecutedAudit["outcome"] = "succeeded";
let lastError: string | null = null;
try { await createTransfer(shopId, input.skuId, from.id, to.id, input.quantity, "instant"); }
catch (err) { outcome = "failed"; lastError = err instanceof Error ? err.message : String(err); }
```

Update `params` to owned ids (`from_location_id`/`to_location_id` = owned ids; drop `inventory_item_id`/`shopify_operation_id`; keep `delta`, names, `sku_id`). Remove the `admin` param + the `inventoryAdjustQuantitiesForShop` import.

- [ ] **Step 2: Swap the alert-driven path in `alert-action.server.ts`**

At the `inventoryAdjustQuantitiesForShop(shopId, admin, plan, sb)` call (~line 109), replace with `createTransfer(shopId, variantId, plan.fromLocationId(owned), plan.toLocationId(owned), plan.delta, "instant")`, resolving the owned location ids + variant the same way (the plan is derived from the alert's evidence). Drop the `admin` argument from this path. Keep the surrounding audit-row recording unchanged.

- [ ] **Step 3: Update the tests** — mock `~/lib/inventory/engine.server` `createTransfer`; assert it's called with owned ids; assert no `inventoryAdjustQuantitiesForShop`/Shopify call; validation-throw cases (same-location, qty-exceeds) stay.

- [ ] **Step 4: Run + verify**

Run: `npx vitest run app/lib/actions/__tests__/inventory-relocate.server.test.ts && npm run typecheck`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add app/lib/actions/inventory-relocate.server.ts app/lib/actions/alert-action.server.ts app/lib/actions/__tests__/inventory-relocate.server.test.ts
git commit -m "feat(actions): reallocate_inventory uses the owned transfer (no Shopify)"
```

---

### Task 4: Re-point `discontinue_sku` to the owned product status

**Files:**
- Modify: `app/lib/actions/alert-action.server.ts` (`executeDiscontinueAlertAction` — the `discontinueProduct` call)
- Modify: `app/lib/actions/discontinue.server.ts` (`resolveSkuForDiscontinue` returns owned product id + prior status)
- Test: `app/lib/actions/__tests__/discontinue.server.test.ts` (update/create)

**Interfaces:**
- Consumes: Slice 1 `setProductStatus(shopId, productId, "archived")`; keeps `setDoNotReorder`.
- Produces: resolve returns `{ variantId, productId (owned), priorStatus, alreadyFlagged }`; the executor records `prior_status` in `params` for undo.

- [ ] **Step 1: Rewrite `resolveSkuForDiscontinue` to read the owned product**

```typescript
export interface ResolvedDiscontinueTarget { variantId: string; productId: string | null; priorStatus: string | null; alreadyFlagged: boolean }

export async function resolveSkuForDiscontinue(sb: SupabaseClient, shopId: string, skuCode: string): Promise<ResolvedDiscontinueTarget | null> {
  const { data, error } = await sb
    .from("variant_dim")
    .select("id, do_not_reorder, product:product_dim(id, status)")
    .eq("shop_id", shopId).eq("sku", skuCode)
    .maybeSingle();
  if (error) throw error;
  if (!data?.id) return null;
  const product = data.product as { id?: string; status?: string } | null;
  return { variantId: String(data.id), productId: product?.id ? String(product.id) : null, priorStatus: product?.status ?? null, alreadyFlagged: data.do_not_reorder === true };
}
```

> Note: `do_not_reorder` lives on `sku_dim` today; if it isn't on `variant_dim`, keep reading/writing it via `sku_dim` by the variant id (= `sku_dim.id`) — `setDoNotReorder` already targets `sku_dim` by `skuId`, which equals `variantId`. No change needed to `setDoNotReorder`.

- [ ] **Step 2: Swap the Shopify archive in `executeDiscontinueAlertAction`**

Replace the `discontinueProduct(admin, productGid, …)` call with `setProductStatus(session.shopId → shopId, target.productId, "archived")` (import from `~/lib/catalog/catalog.server`). Keep `setDoNotReorder(sb, shopId, target.variantId, true)`. Record `prior_status: target.priorStatus` in the audit `params`. Drop the `admin` dependency. Surface the "no product" 422 when `target.productId` is null (unchanged guard).

- [ ] **Step 3: Update the test** — mock `~/lib/catalog/catalog.server` `setProductStatus`; assert it's called with `(shopId, productId, "archived")`, `setDoNotReorder` still called, `params.prior_status` recorded, no `discontinueProduct`/Shopify call.

- [ ] **Step 4: Run + verify**

Run: `npx vitest run app/lib/actions/__tests__/discontinue.server.test.ts && npm run typecheck`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add app/lib/actions/alert-action.server.ts app/lib/actions/discontinue.server.ts app/lib/actions/__tests__/discontinue.server.test.ts
git commit -m "feat(actions): discontinue_sku archives the owned product (no Shopify)"
```

---

### Task 5: Re-point the three undo branches

**Files:**
- Modify: `app/lib/actions/undo.server.ts`
- Test: `app/lib/actions/__tests__/undo.server.test.ts` (update)

**Interfaces:**
- Consumes: owned `setVariantPrice`, `setProductStatus` (catalog), `createTransfer` (inventory). The `deps.admin` parameter is no longer required for these three kinds.

- [ ] **Step 1: Swap the `reallocate_inventory` undo branch**

Replace the `availableAtLocation` (Shopify-fact) + `inventoryAdjustQuantitiesForShop` reversal with an owned reverse transfer. Read availability from `inventory_balance` at the original destination; refuse if it can't cover; then `createTransfer` with locations swapped:

```typescript
} else if (orig.action_kind === "reallocate_inventory") {
  const ip = (orig.params ?? {}) as { sku_id?: string; from_location_id?: string; to_location_id?: string; delta?: number };
  const delta = Number(ip.delta ?? 0);
  if (!ip.sku_id || !ip.from_location_id || !ip.to_location_id || !delta) throw new Error(`audit ${auditId} lacks a replayable transfer plan; cannot undo`);
  const { data: bal } = await sb.from("inventory_balance").select("available").eq("shop_id", shopId).eq("variant_id", ip.sku_id).eq("location_id", ip.to_location_id).maybeSingle();
  const destAvailable = Number(bal?.available ?? 0);
  if (destAvailable < delta) throw new Error(`cannot undo inventory transfer: destination now holds ${destAvailable}, fewer than the ${delta} the reverse would move back`);
  await createTransfer(shopId, ip.sku_id, ip.to_location_id, ip.from_location_id, delta, "instant");
}
```

(The `appliedInventoryOperationId` do-not-retry guard around the undo-row insert stays meaningful — set a local flag `reversedInventory = true` after `createTransfer` and reuse the existing "applied but record failed" error path.)

- [ ] **Step 2: Swap the `discontinue_sku` undo branch**

```typescript
} else if (orig.action_kind === "discontinue_sku") {
  const dp = (orig.params ?? {}) as { sku_id?: string; product_id?: string; prior_status?: string };
  if (!dp.product_id || !dp.sku_id) throw new Error(`audit ${auditId} lacks the product/sku to restore; cannot undo`);
  await setProductStatus(shopId, dp.product_id, (dp.prior_status === "draft" ? "draft" : "active"));
  await setDoNotReorder(sb, shopId, dp.sku_id, false);
}
```

- [ ] **Step 3: Swap the `adjust_price` undo branch**

```typescript
} else if (orig.action_kind === "adjust_price") {
  const pp = (orig.params ?? {}) as { variant_id?: string; prior_price_cents?: number };
  if (!pp.variant_id || pp.prior_price_cents == null) throw new Error(`audit ${auditId} lacks the variant/prior price to restore; cannot undo`);
  await setVariantPrice(shopId, pp.variant_id, Number(pp.prior_price_cents));
}
```

- [ ] **Step 4: Drop the now-unneeded Shopify deps** — remove the `restoreProduct`/Shopify `setVariantPrice`/`inventoryAdjustQuantitiesForShop` imports and the `deps.admin` requirement guards for these three branches (campaign-kind undos still use `requireAdapter`). Import owned `setVariantPrice`, `setProductStatus` (catalog) + `createTransfer` (inventory).

- [ ] **Step 5: Update the undo test** — assert each branch calls the owned primitive (no Shopify), the destination-availability refusal still throws, and the negative-impact undo row is still written.

- [ ] **Step 6: Run + verify**

Run: `npx vitest run app/lib/actions/__tests__/undo.server.test.ts && npm run typecheck`
Expected: PASS; clean.

- [ ] **Step 7: Commit**

```bash
git add app/lib/actions/undo.server.ts app/lib/actions/__tests__/undo.server.test.ts
git commit -m "feat(actions): undo branches reverse against owned tables (no Shopify)"
```

---

### Task 6: Full gate + no-Shopify sweep

- [ ] **Step 1: Confirm no Shopify writes remain in these paths**

Run: `npx grep -rn "shopify/price.server|shopify/product.server|inventoryAdjustQuantitiesForShop|readVariantPrice" app/lib/actions/ || rg -n "shopify/price.server|shopify/product.server|inventoryAdjustQuantitiesForShop|readVariantPrice" app/lib/actions/`
Expected: no hits in `adjust-price.server.ts`, `inventory-relocate.server.ts`, `discontinue.server.ts`, `undo.server.ts`, or the store-action paths of `alert-action.server.ts`. (Remaining hits, if any, are campaign-only paths — leave them.)

- [ ] **Step 2: Run the whole gate** (pasting results — rule 12)

```bash
npm run typecheck   # exit 0
npm run lint        # exit 0
npm run build       # exit 0
npx vitest run      # all green — the existing action/calibration/autopilot suites prove the shared machinery is intact
```

- [ ] **Step 3: Commit any fixups**

```bash
git add -A
git commit -m "chore(actions): green gate for owned store-action executors"
```

---

## Self-Review

**Spec coverage (against `docs/superpowers/specs/2026-06-29-slice-store-action-executor-design.md`):**
- `adjust_price` → owned `setVariantPrice`, prior price for undo → Tasks 1, 2. ✅
- `reallocate_inventory` → owned `createTransfer`, owned location ids → Task 3 (both merchant + alert paths). ✅
- `discontinue_sku` → owned `setProductStatus("archived")` + DNR flag + prior status → Task 4. ✅
- Undo re-pointed for all three, admin dep dropped → Task 5. ✅
- Audit/idempotency/calibration/graduation unchanged → no edits to `execute.server.ts`'s tail or the calibration code; verified by existing suites in Task 6. ✅
- No Shopify calls → Task 6 sweep. ✅
- Pre-state read before write → Tasks 2 (prior price), 3 (transfer plan), 4 (prior status). ✅

**Demo-mode note (spec risk):** the old reallocate went through `inventoryAdjustQuantitiesForShop` in `demo/showcase.server` (which simulated for `demo_mode` shops). The owned `createTransfer` writes the owned balance directly — which for a seeded demo store IS the demo data, so the action genuinely works on it (no simulation needed). Task 3's test should include a demo-mode shop to confirm the owned write behaves; if any path still branches on `demo_mode` before the write, leave that guard intact.

**Placeholder scan:** none — every swap shows the replacement code.

**Type consistency:** `setVariantPrice(shopId, variantId, priceCents) → {priorPriceCents}` (Task 1) is used by Task 2 (forward) and Task 5 (undo). `createTransfer(shopId, variantId, from, to, qty, "instant")` (Slice 2) is used by Tasks 3 + 5. `setProductStatus(shopId, productId, status)` (Slice 1) by Tasks 4 + 5. Owned `params` ids (`variant_id`, `product_id`, owned `from/to_location_id`, `prior_price_cents`, `prior_status`) are written by Tasks 2-4 and read by Task 5's undo branches — matched.

**Boundary preserved:** no change to `executeAction` (the campaign executor), the audit tail, or the calibration RPCs — the autopilot/graduation behavior is unchanged; only the three store executors' write bodies + their undo branches move to owned tables.
