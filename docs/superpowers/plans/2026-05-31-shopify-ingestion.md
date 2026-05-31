# Shopify Real-Data Ingestion (Slice 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A live Shopify shop's real catalog, inventory, and 30-day order history flow into Supabase fact tables and produce a real `reorder_timing` alert, lighting up `v_skus_flat` and `v_alerts_view` with zero seed data.

**Architecture:** Webhooks land raw rows (already wired); Vercel cron drives three phases — backfill (Admin GraphQL → facts), transform (raw → facts), detect (`v_skus_flat` → alerts). Background Admin API calls use `unauthenticated.admin(shop)` against the offline session already stored in `shopify_sessions`. Pure mapping/scoring logic is isolated and unit-tested; IO orchestration is thin.

**Tech Stack:** Remix (Vite) on Vercel, `@shopify/shopify-app-remix` (Admin GraphQL), `@supabase/supabase-js` (service role), Vitest (new dev dependency), Supabase migrations for the analytics schema.

**Spec:** `docs/superpowers/specs/2026-05-31-shopify-ingestion-design.md`

**Confirmed facts (verified against Supabase project `ajgrmnvzxfxxlwrxcgnu`):**
- Unique constraints already exist: `sku_dim(shop_id,external_id)`, `location_dim(shop_id,external_id)`, `order_fact(shop_id,external_id)`, `order_line_fact(order_id,external_line_id)`, `inventory_level_fact(sku_id,location_id,source_version)`, `shop_integrations(shop_id,kind)`, `alerts(shop_id,detector_id,entity_ref,day_bucket)`, `alert_thresholds` PK `(shop_id,detector_id)`.
- Enums: `alert_severity = {low,medium,high,critical}`, `alert_status = {open,acknowledged,resolved,snoozed,dismissed}`, `integration_kind = {shopify,meta_ads,google_ads,quickbooks}`.
- `removeRest: true` is set → Admin **GraphQL only**.
- `dollar_impact` / `dollar_impact_at_exec` are stored in **dollars** (numeric); `rowToAlert` multiplies by 100 for the UI.

---

## File Structure

**Create:**
- `app/lib/ingest/types.ts` — row/draft TypeScript types (no runtime)
- `app/lib/ingest/mappers.server.ts` — pure Shopify-payload → fact-row functions + helpers
- `app/lib/ingest/detectors/reorder-timing.server.ts` — pure scoring + DB runner
- `app/lib/ingest/shopify-admin.server.ts` — paginated Admin GraphQL queries
- `app/lib/ingest/backfill.server.ts` — orchestrates one shop's backfill
- `app/lib/ingest/transform.server.ts` — drain `raw_shopify_webhook` → facts
- `app/lib/ingest/dlq.server.ts` — `ingestion_dlq` writer
- `app/lib/ingest/enqueue.server.ts` — mark a shop pending (afterAuth)
- `app/routes/cron.ingest.tsx` — cron resource route (auth + 3 phases)
- `app/routes/webhooks.orders.create.tsx` — land `orders/create` raw
- `app/lib/ingest/__tests__/mappers.test.ts`
- `app/lib/ingest/__tests__/reorder-timing.test.ts`
- `vitest.config.ts`
- `supabase/migrations/<ts>_raw_shopify_webhook_processed_at.sql`

**Modify:**
- `package.json` — add Vitest + `test` script
- `app/shopify.server.ts` — call `enqueueShopifyBackfill` in `afterAuth`
- `shopify.app.calderynextension.toml` — add `orders/create` subscription
- `vercel.json` — add `crons`
- `.env.example` — add `CRON_SECRET`

---

## Task 1: Add Vitest test runner

**Dependency flag (CLAUDE.md "no new top-level deps without flagging"):** Vitest is the standard runner for Vite projects, dev-only, zero production bundle impact, and reuses the existing Vite/tsconfig-paths config. No alternative considered worthwhile given the stack.

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `app/lib/ingest/__tests__/smoke.test.ts`

- [ ] **Step 1: Install Vitest**

```bash
npm install -D vitest
```

- [ ] **Step 2: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["app/**/*.test.ts"],
  },
});
```

- [ ] **Step 3: Add the `test` script to `package.json`**

In the `"scripts"` block add:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 4: Write a smoke test**

`app/lib/ingest/__tests__/smoke.test.ts`:

```ts
import { describe, it, expect } from "vitest";

describe("vitest wiring", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: Run it**

Run: `npm test`
Expected: 1 passed.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.ts app/lib/ingest/__tests__/smoke.test.ts
git commit -m "test: add vitest runner for ingestion modules"
```

---

## Task 2: Supabase migration — `raw_shopify_webhook.processed_at`

**Files:**
- Create: `supabase/migrations/<timestamp>_raw_shopify_webhook_processed_at.sql`

**Note:** This is a **Supabase-managed** table, not Prisma (`prisma/schema.prisma` only owns `shopify_sessions`). Apply via the Supabase CLI, not `prisma migrate`. This is the documented carve-out from CLAUDE.md (spec §10).

- [ ] **Step 1: Create the migration file**

Generate the filename with `supabase migration new raw_shopify_webhook_processed_at` (or name it `<YYYYMMDDHHMMSS>_raw_shopify_webhook_processed_at.sql`). Contents:

```sql
alter table public.raw_shopify_webhook
  add column if not exists processed_at timestamptz null;

create index if not exists raw_shopify_webhook_unprocessed_idx
  on public.raw_shopify_webhook (received_at)
  where processed_at is null;
```

- [ ] **Step 2: Apply it**

Run: `supabase db push` (or `supabase migration up` against the linked project).
Expected: migration applied, no error.

- [ ] **Step 3: Verify the column exists**

Run this query (Supabase SQL editor or `psql`):

```sql
select column_name from information_schema.columns
where table_schema='public' and table_name='raw_shopify_webhook' and column_name='processed_at';
```

Expected: one row, `processed_at`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations
git commit -m "feat(db): add raw_shopify_webhook.processed_at for transform draining"
```

---

## Task 3: Ingest types + GID/money helpers

**Files:**
- Create: `app/lib/ingest/types.ts`
- Create: `app/lib/ingest/mappers.server.ts`
- Create: `app/lib/ingest/__tests__/mappers.test.ts`

- [ ] **Step 1: Write failing tests for helpers**

`app/lib/ingest/__tests__/mappers.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { gidToId, moneyToCents } from "../mappers.server";

describe("gidToId", () => {
  it("extracts the trailing id from a Shopify GID", () => {
    expect(gidToId("gid://shopify/ProductVariant/12345")).toBe("12345");
  });
  it("returns the input unchanged when no slash segment", () => {
    expect(gidToId("12345")).toBe("12345");
  });
});

describe("moneyToCents", () => {
  it("converts decimal strings to integer cents", () => {
    expect(moneyToCents("19.99")).toBe(1999);
  });
  it("treats null/undefined as 0", () => {
    expect(moneyToCents(null)).toBe(0);
    expect(moneyToCents(undefined)).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — cannot import from `../mappers.server` (module not found).

- [ ] **Step 3: Create `app/lib/ingest/types.ts`**

```ts
export type LocationRow = {
  shop_id: string;
  external_id: string;
  name: string;
  active: boolean;
};

export type SkuRow = {
  shop_id: string;
  external_id: string;
  product_id: string;
  inventory_item_id: string | null;
  sku: string | null;
  title: string;
  unit_cost_cents: number | null;
  currency: string;
  tags: string[];
};

export type InventoryRow = {
  shop_id: string;
  sku_id: string;
  location_id: string;
  available: number;
  observed_at: string;
  source_version: number;
};

export type OrderRow = {
  shop_id: string;
  external_id: string;
  order_number: string;
  created_at_source: string;
  total_cents: number;
  subtotal_cents: number;
  shipping_cents: number;
  tax_cents: number;
  discount_cents: number;
  currency: string;
  financial_status: string | null;
  source_version: number;
};

// sku is carried as the variant GID; the writer resolves it to sku_dim.id.
export type OrderLineRow = {
  sku_external_id: string | null;
  external_line_id: string;
  quantity: number;
  price_cents: number;
  total_cents: number;
};
```

- [ ] **Step 4: Create `app/lib/ingest/mappers.server.ts` with the helpers**

```ts
export function gidToId(gid: string): string {
  const m = gid.match(/\/([^/]+)$/);
  return m ? m[1] : gid;
}

export function moneyToCents(amount: string | number | null | undefined): number {
  if (amount === null || amount === undefined || amount === "") return 0;
  return Math.round(Number(amount) * 100);
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npm test`
Expected: PASS (helper tests + smoke).

- [ ] **Step 6: Commit**

```bash
git add app/lib/ingest/types.ts app/lib/ingest/mappers.server.ts app/lib/ingest/__tests__/mappers.test.ts
git commit -m "feat(ingest): add row types and GID/money helpers"
```

---

## Task 4: Pure mappers — location, sku, order, order lines

These take **already-parsed** Admin GraphQL node objects and return fact rows. `shop_id` is passed in (resolved by the caller). All functions are pure.

**Files:**
- Modify: `app/lib/ingest/mappers.server.ts`
- Modify: `app/lib/ingest/__tests__/mappers.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `app/lib/ingest/__tests__/mappers.test.ts`:

```ts
import { mapLocation, mapVariantToSku, mapOrder, mapOrderLines } from "../mappers.server";

const SHOP = "00000000-0000-0000-0000-000000000001";

describe("mapLocation", () => {
  it("maps a location node", () => {
    expect(
      mapLocation(SHOP, { id: "gid://shopify/Location/7", name: "Main", isActive: true }),
    ).toEqual({ shop_id: SHOP, external_id: "gid://shopify/Location/7", name: "Main", active: true });
  });
});

describe("mapVariantToSku", () => {
  it("maps a variant + product into a sku row with unit cost in cents", () => {
    const product = { id: "gid://shopify/Product/100", title: "Widget" };
    const variant = {
      id: "gid://shopify/ProductVariant/200",
      sku: "WID-1",
      title: "Small",
      inventoryItem: { id: "gid://shopify/InventoryItem/300", unitCost: { amount: "4.50" } },
    };
    expect(mapVariantToSku(SHOP, product, variant)).toEqual({
      shop_id: SHOP,
      external_id: "gid://shopify/ProductVariant/200",
      product_id: "gid://shopify/Product/100",
      inventory_item_id: "gid://shopify/InventoryItem/300",
      sku: "WID-1",
      title: "Widget — Small",
      unit_cost_cents: 450,
      currency: "USD",
      tags: [],
    });
  });
  it("tolerates missing unit cost and sku", () => {
    const product = { id: "gid://shopify/Product/100", title: "Widget" };
    const variant = { id: "gid://shopify/ProductVariant/200", title: "Default Title", inventoryItem: { id: null } };
    const row = mapVariantToSku(SHOP, product, variant);
    expect(row.unit_cost_cents).toBeNull();
    expect(row.sku).toBeNull();
    expect(row.title).toBe("Widget");
  });
});

describe("mapOrder / mapOrderLines", () => {
  const orderNode = {
    id: "gid://shopify/Order/900",
    name: "#1001",
    createdAt: "2026-05-01T12:00:00Z",
    updatedAt: "2026-05-01T12:00:00Z",
    displayFinancialStatus: "PAID",
    currentTotalPriceSet: { shopMoney: { amount: "59.97", currencyCode: "USD" } },
    currentSubtotalPriceSet: { shopMoney: { amount: "54.00" } },
    totalShippingPriceSet: { shopMoney: { amount: "5.00" } },
    currentTotalTaxSet: { shopMoney: { amount: "0.97" } },
    currentTotalDiscountsSet: { shopMoney: { amount: "0.00" } },
    lineItems: {
      nodes: [
        {
          id: "gid://shopify/LineItem/1",
          quantity: 3,
          variant: { id: "gid://shopify/ProductVariant/200" },
          originalUnitPriceSet: { shopMoney: { amount: "18.00" } },
        },
      ],
    },
  };

  it("maps the order header", () => {
    expect(mapOrder(SHOP, orderNode)).toEqual({
      shop_id: SHOP,
      external_id: "gid://shopify/Order/900",
      order_number: "#1001",
      created_at_source: "2026-05-01T12:00:00Z",
      total_cents: 5997,
      subtotal_cents: 5400,
      shipping_cents: 500,
      tax_cents: 97,
      discount_cents: 0,
      currency: "USD",
      financial_status: "PAID",
      source_version: Date.parse("2026-05-01T12:00:00Z"),
    });
  });

  it("maps order lines, carrying the variant GID", () => {
    expect(mapOrderLines(orderNode)).toEqual([
      {
        sku_external_id: "gid://shopify/ProductVariant/200",
        external_line_id: "gid://shopify/LineItem/1",
        quantity: 3,
        price_cents: 1800,
        total_cents: 5400,
      },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — `mapLocation` etc. not exported.

- [ ] **Step 3: Implement the mappers**

Append to `app/lib/ingest/mappers.server.ts`:

```ts
import type { LocationRow, SkuRow, OrderRow, OrderLineRow } from "./types";

type LocationNode = { id: string; name: string; isActive?: boolean };
type ProductNode = { id: string; title: string };
type VariantNode = {
  id: string;
  sku?: string | null;
  title?: string | null;
  inventoryItem?: { id?: string | null; unitCost?: { amount?: string | null } | null } | null;
};
type Money = { shopMoney?: { amount?: string | null; currencyCode?: string | null } | null };
type OrderNode = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  displayFinancialStatus?: string | null;
  currentTotalPriceSet?: Money;
  currentSubtotalPriceSet?: Money;
  totalShippingPriceSet?: Money;
  currentTotalTaxSet?: Money;
  currentTotalDiscountsSet?: Money;
  lineItems?: { nodes?: OrderLineNode[] };
};
type OrderLineNode = {
  id: string;
  quantity: number;
  variant?: { id?: string | null } | null;
  originalUnitPriceSet?: Money;
};

function amount(m: Money | undefined): string | null {
  return m?.shopMoney?.amount ?? null;
}

export function mapLocation(shopId: string, n: LocationNode): LocationRow {
  return { shop_id: shopId, external_id: n.id, name: n.name, active: n.isActive ?? true };
}

export function mapVariantToSku(shopId: string, product: ProductNode, variant: VariantNode): SkuRow {
  const variantTitle = variant.title && variant.title !== "Default Title" ? variant.title : null;
  const unitCost = variant.inventoryItem?.unitCost?.amount;
  return {
    shop_id: shopId,
    external_id: variant.id,
    product_id: product.id,
    inventory_item_id: variant.inventoryItem?.id ?? null,
    sku: variant.sku ?? null,
    title: variantTitle ? `${product.title} — ${variantTitle}` : product.title,
    unit_cost_cents: unitCost != null ? moneyToCents(unitCost) : null,
    currency: amount(variant as never) ? "USD" : "USD",
    tags: [],
  };
}

export function mapOrder(shopId: string, o: OrderNode): OrderRow {
  return {
    shop_id: shopId,
    external_id: o.id,
    order_number: o.name,
    created_at_source: o.createdAt,
    total_cents: moneyToCents(amount(o.currentTotalPriceSet)),
    subtotal_cents: moneyToCents(amount(o.currentSubtotalPriceSet)),
    shipping_cents: moneyToCents(amount(o.totalShippingPriceSet)),
    tax_cents: moneyToCents(amount(o.currentTotalTaxSet)),
    discount_cents: moneyToCents(amount(o.currentTotalDiscountsSet)),
    currency: o.currentTotalPriceSet?.shopMoney?.currencyCode ?? "USD",
    financial_status: o.displayFinancialStatus ?? null,
    source_version: Date.parse(o.updatedAt),
  };
}

export function mapOrderLines(o: OrderNode): OrderLineRow[] {
  return (o.lineItems?.nodes ?? []).map((ln) => {
    const priceCents = moneyToCents(amount(ln.originalUnitPriceSet));
    return {
      sku_external_id: ln.variant?.id ?? null,
      external_line_id: ln.id,
      quantity: ln.quantity,
      price_cents: priceCents,
      total_cents: priceCents * ln.quantity,
    };
  });
}
```

> Note: `currency` on `SkuRow` is hardcoded `"USD"` for Slice 1 (variant nodes don't carry a currency in the query); the `amount(variant as never)` expression is intentionally removed in Step 3 review — replace the `currency` line with `currency: "USD",` and drop the unused expression. (See self-review note at end of plan; keep it simply `currency: "USD"`.)

- [ ] **Step 4: Simplify `currency` line**

Edit `mapVariantToSku` so the field reads exactly:

```ts
    currency: "USD",
```

(Remove the `amount(variant as never) ? ...` ternary entirely.)

- [ ] **Step 5: Run to verify pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add app/lib/ingest/mappers.server.ts app/lib/ingest/__tests__/mappers.test.ts
git commit -m "feat(ingest): pure mappers for location/sku/order/order-line facts"
```

---

## Task 5: Pure webhook parsers (inventory / order / product)

Webhook payloads (REST-shaped JSON Shopify sends) differ from GraphQL nodes. Parse them to a normalized intermediate the transform writer can resolve. Pure functions.

**Files:**
- Modify: `app/lib/ingest/mappers.server.ts`
- Modify: `app/lib/ingest/__tests__/mappers.test.ts`

- [ ] **Step 1: Add failing tests**

Append to the test file:

```ts
import { parseInventoryWebhook, parseOrderWebhook } from "../mappers.server";

describe("parseInventoryWebhook", () => {
  it("normalizes an inventory_levels/update payload", () => {
    const payload = {
      inventory_item_id: 300,
      location_id: 7,
      available: 12,
      updated_at: "2026-05-10T00:00:00Z",
    };
    expect(parseInventoryWebhook(payload)).toEqual({
      inventory_item_external_id: "gid://shopify/InventoryItem/300",
      location_external_id: "gid://shopify/Location/7",
      available: 12,
      observed_at: "2026-05-10T00:00:00Z",
      source_version: Date.parse("2026-05-10T00:00:00Z"),
    });
  });
});

describe("parseOrderWebhook", () => {
  it("normalizes an orders/create payload", () => {
    const payload = {
      admin_graphql_api_id: "gid://shopify/Order/900",
      name: "#1001",
      created_at: "2026-05-01T12:00:00Z",
      updated_at: "2026-05-01T12:00:00Z",
      financial_status: "paid",
      currency: "USD",
      total_price: "59.97",
      subtotal_price: "54.00",
      total_tax: "0.97",
      total_discounts: "0.00",
      total_shipping_price_set: { shop_money: { amount: "5.00" } },
      line_items: [
        {
          admin_graphql_api_id: "gid://shopify/LineItem/1",
          quantity: 3,
          price: "18.00",
          variant_id: 200,
        },
      ],
    };
    const parsed = parseOrderWebhook(payload);
    expect(parsed.order).toEqual({
      external_id: "gid://shopify/Order/900",
      order_number: "#1001",
      created_at_source: "2026-05-01T12:00:00Z",
      total_cents: 5997,
      subtotal_cents: 5400,
      shipping_cents: 500,
      tax_cents: 97,
      discount_cents: 0,
      currency: "USD",
      financial_status: "paid",
      source_version: Date.parse("2026-05-01T12:00:00Z"),
    });
    expect(parsed.lines).toEqual([
      {
        sku_external_id: "gid://shopify/ProductVariant/200",
        external_line_id: "gid://shopify/LineItem/1",
        quantity: 3,
        price_cents: 1800,
        total_cents: 5400,
      },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — parsers not exported.

- [ ] **Step 3: Implement the parsers**

Append to `app/lib/ingest/mappers.server.ts`:

```ts
import type { OrderLineRow } from "./types";

export type ParsedInventory = {
  inventory_item_external_id: string;
  location_external_id: string;
  available: number;
  observed_at: string;
  source_version: number;
};

export function parseInventoryWebhook(p: Record<string, unknown>): ParsedInventory {
  const updatedAt = String(p.updated_at ?? new Date().toISOString());
  return {
    inventory_item_external_id: `gid://shopify/InventoryItem/${p.inventory_item_id}`,
    location_external_id: `gid://shopify/Location/${p.location_id}`,
    available: Number(p.available ?? 0),
    observed_at: updatedAt,
    source_version: Date.parse(updatedAt),
  };
}

export type ParsedOrderHeader = Omit<OrderRow, "shop_id">;

export function parseOrderWebhook(p: Record<string, any>): {
  order: ParsedOrderHeader;
  lines: OrderLineRow[];
} {
  const updatedAt = String(p.updated_at ?? p.created_at);
  const order: ParsedOrderHeader = {
    external_id: String(p.admin_graphql_api_id),
    order_number: String(p.name),
    created_at_source: String(p.created_at),
    total_cents: moneyToCents(p.total_price),
    subtotal_cents: moneyToCents(p.subtotal_price),
    shipping_cents: moneyToCents(p.total_shipping_price_set?.shop_money?.amount),
    tax_cents: moneyToCents(p.total_tax),
    discount_cents: moneyToCents(p.total_discounts),
    currency: String(p.currency ?? "USD"),
    financial_status: p.financial_status ?? null,
    source_version: Date.parse(updatedAt),
  };
  const lines: OrderLineRow[] = (p.line_items ?? []).map((ln: Record<string, any>) => {
    const priceCents = moneyToCents(ln.price);
    return {
      sku_external_id: ln.variant_id ? `gid://shopify/ProductVariant/${ln.variant_id}` : null,
      external_line_id: String(ln.admin_graphql_api_id),
      quantity: Number(ln.quantity ?? 0),
      price_cents: priceCents,
      total_cents: priceCents * Number(ln.quantity ?? 0),
    };
  });
  return { order, lines };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/ingest/mappers.server.ts app/lib/ingest/__tests__/mappers.test.ts
git commit -m "feat(ingest): pure parsers for inventory/order webhook payloads"
```

---

## Task 6: Reorder-timing detector — pure scoring

**Files:**
- Create: `app/lib/ingest/detectors/reorder-timing.server.ts`
- Create: `app/lib/ingest/__tests__/reorder-timing.test.ts`

- [ ] **Step 1: Write failing tests**

`app/lib/ingest/__tests__/reorder-timing.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  scoreReorderTiming,
  DEFAULT_REORDER_THRESHOLD,
  type SkuFlat,
} from "../detectors/reorder-timing.server";

const NOW = new Date("2026-05-31T00:00:00Z");

function sku(over: Partial<SkuFlat>): SkuFlat {
  return { id: "s1", sku: "SKU1", title: "Thing", on_hand: 10, velocity: 1, days_of_cover: 10, ...over };
}

describe("scoreReorderTiming", () => {
  it("returns nothing when no sku breaches", () => {
    expect(scoreReorderTiming([sku({ days_of_cover: 30 })], {}, DEFAULT_REORDER_THRESHOLD, NOW)).toEqual([]);
  });

  it("excludes slow movers below min_velocity", () => {
    const out = scoreReorderTiming([sku({ days_of_cover: 2, velocity: 0.05 })], {}, DEFAULT_REORDER_THRESHOLD, NOW);
    expect(out).toEqual([]);
  });

  it("flags a critical low-stock sku", () => {
    const out = scoreReorderTiming(
      [sku({ id: "s1", days_of_cover: 2, velocity: 2 })],
      { s1: 1000 },
      DEFAULT_REORDER_THRESHOLD,
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("critical");
    expect(out[0].claude_rank).toBe(1);
    expect(out[0].entity_ref).toEqual({ sku: "SKU1", sku_id: "s1", title: "Thing" });
    // unmet = (14 - 2) * 2 = 24 units; impact = 24 * $10 = $240
    expect(out[0].dollar_impact).toBeCloseTo(240);
    expect(out[0].evidence.days_of_cover).toBe(2);
  });

  it("ranks by dollar impact descending", () => {
    const out = scoreReorderTiming(
      [
        sku({ id: "low", days_of_cover: 5, velocity: 1 }),
        sku({ id: "high", days_of_cover: 5, velocity: 5 }),
      ],
      { low: 500, high: 500 },
      DEFAULT_REORDER_THRESHOLD,
      NOW,
    );
    expect(out.map((d) => d.sku_id)).toEqual(["high", "low"]);
    expect(out[0].claude_rank).toBe(1);
    expect(out[1].claude_rank).toBe(2);
  });

  it("assigns severity by days_of_cover bands", () => {
    const [crit] = scoreReorderTiming([sku({ days_of_cover: 2, velocity: 1 })], {}, DEFAULT_REORDER_THRESHOLD, NOW);
    const [high] = scoreReorderTiming([sku({ days_of_cover: 5, velocity: 1 })], {}, DEFAULT_REORDER_THRESHOLD, NOW);
    const [med] = scoreReorderTiming([sku({ days_of_cover: 10, velocity: 1 })], {}, DEFAULT_REORDER_THRESHOLD, NOW);
    expect([crit.severity, high.severity, med.severity]).toEqual(["critical", "high", "medium"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure scoring**

`app/lib/ingest/detectors/reorder-timing.server.ts`:

```ts
export type SkuFlat = {
  id: string;
  sku: string | null;
  title: string;
  on_hand: number;
  velocity: number;
  days_of_cover: number;
};

export type ReorderThreshold = {
  days_of_cover_lt: number;
  min_velocity: number;
  horizon_days: number;
};

export const DEFAULT_REORDER_THRESHOLD: ReorderThreshold = {
  days_of_cover_lt: 14,
  min_velocity: 0.1,
  horizon_days: 14,
};

export const DETECTOR_ID = "reorder_timing";

export type AlertDraft = {
  sku_id: string;
  entity_ref: { sku: string; sku_id: string; title: string };
  severity: "critical" | "high" | "medium";
  dollar_impact: number; // dollars (DB stores dollars)
  claude_rank: number;
  claude_narrative: string;
  evidence: Record<string, unknown>;
};

export function scoreReorderTiming(
  skus: SkuFlat[],
  avgSellPriceCents: Record<string, number>,
  threshold: ReorderThreshold,
  now: Date,
): AlertDraft[] {
  const drafts: AlertDraft[] = skus
    .filter((s) => s.velocity >= threshold.min_velocity && s.days_of_cover < threshold.days_of_cover_lt)
    .map((s) => {
      const unmetUnits = Math.max(0, threshold.horizon_days - s.days_of_cover) * s.velocity;
      const priceCents = avgSellPriceCents[s.id] ?? 0;
      const dollarImpact = (unmetUnits * priceCents) / 100;
      const severity = s.days_of_cover < 3 ? "critical" : s.days_of_cover < 7 ? "high" : "medium";
      const stockoutDate = new Date(now.getTime() + s.days_of_cover * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const narrative =
        `${s.title} has ${s.days_of_cover} days of cover at ${s.velocity}/day and will stock out around ${stockoutDate}. ` +
        `Reorder now to avoid ~$${dollarImpact.toFixed(0)} in lost sales over the next ${threshold.horizon_days} days.`;
      return {
        sku_id: s.id,
        entity_ref: { sku: s.sku ?? s.id, sku_id: s.id, title: s.title },
        severity,
        dollar_impact: dollarImpact,
        claude_rank: 0,
        claude_narrative: narrative,
        evidence: {
          on_hand: s.on_hand,
          velocity: s.velocity,
          days_of_cover: s.days_of_cover,
          avg_sell_price_cents: priceCents,
          horizon_days: threshold.horizon_days,
          threshold,
        },
      };
    });

  drafts.sort((a, b) => b.dollar_impact - a.dollar_impact);
  drafts.forEach((d, i) => (d.claude_rank = i + 1));
  return drafts;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/ingest/detectors/reorder-timing.server.ts app/lib/ingest/__tests__/reorder-timing.test.ts
git commit -m "feat(ingest): reorder_timing detector scoring (pure)"
```

---

## Task 7: DLQ writer + enqueue helper

**Files:**
- Create: `app/lib/ingest/dlq.server.ts`
- Create: `app/lib/ingest/enqueue.server.ts`

- [ ] **Step 1: Implement the DLQ writer**

`app/lib/ingest/dlq.server.ts`:

```ts
import { getSupabase } from "../supabase.server";

export async function writeDlq(opts: {
  shopId: string | null;
  jobKind: string;
  errorKind: string;
  errorMessage: string;
  payload: unknown;
}): Promise<void> {
  const { error } = await getSupabase().from("ingestion_dlq").insert({
    shop_id: opts.shopId,
    connector: "shopify",
    job_kind: opts.jobKind,
    attempts: 1,
    error_kind: opts.errorKind,
    error_message: opts.errorMessage.slice(0, 2000),
    payload: (opts.payload ?? {}) as object,
  });
  if (error) {
    // Never let DLQ failure mask the original error; log and move on (rule 12: stay visible).
    console.error("[ingest] failed to write ingestion_dlq", error, opts.jobKind);
  }
}
```

- [ ] **Step 2: Implement the enqueue helper**

`app/lib/ingest/enqueue.server.ts`:

```ts
import { getSupabase, resolveShopId } from "../supabase.server";

/**
 * Mark a shop's Shopify integration as pending so the backfill cron picks it up.
 * Idempotent: keeps an existing 'ready' row pending only if it has never synced.
 */
export async function enqueueShopifyBackfill(shopDomain: string): Promise<void> {
  const shopId = await resolveShopId(shopDomain);
  const sb = getSupabase();
  const { error } = await sb.from("shop_integrations").upsert(
    {
      shop_id: shopId,
      kind: "shopify",
      scopes: ["read_products", "read_inventory", "read_orders", "read_locations"],
      sync_status: "pending",
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "shop_id,kind", ignoreDuplicates: false },
  );
  if (error) throw error;
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add app/lib/ingest/dlq.server.ts app/lib/ingest/enqueue.server.ts
git commit -m "feat(ingest): DLQ writer and backfill enqueue helper"
```

---

## Task 8: Admin GraphQL query layer

Fetches locations, products+variants+inventory, and 30-day orders, returning **parsed JSON nodes** (not fact rows — mapping happens in the caller so it stays testable).

**Files:**
- Create: `app/lib/ingest/shopify-admin.server.ts`

- [ ] **Step 1: Implement the query layer**

`app/lib/ingest/shopify-admin.server.ts`:

```ts
import { unauthenticated } from "../../shopify.server";

type AdminClient = Awaited<ReturnType<typeof unauthenticated.admin>>["admin"];

async function adminFor(shopDomain: string): Promise<AdminClient> {
  const { admin } = await unauthenticated.admin(shopDomain);
  return admin;
}

async function gql<T>(admin: AdminClient, query: string, variables?: Record<string, unknown>): Promise<T> {
  const resp = await admin.graphql(query, variables ? { variables } : undefined);
  const body = (await resp.json()) as { data?: T; errors?: unknown };
  if (body.errors) {
    throw new Error(`Admin GraphQL error: ${JSON.stringify(body.errors)}`);
  }
  if (!body.data) throw new Error("Admin GraphQL returned no data");
  return body.data;
}

export async function fetchLocations(shopDomain: string) {
  const admin = await adminFor(shopDomain);
  const data = await gql<{ locations: { nodes: Array<{ id: string; name: string; isActive: boolean }> } }>(
    admin,
    `#graphql
    query Locations {
      locations(first: 100) { nodes { id name isActive } }
    }`,
  );
  return data.locations.nodes;
}

export type AdminVariant = {
  id: string;
  sku: string | null;
  title: string | null;
  inventoryItem: {
    id: string | null;
    unitCost: { amount: string } | null;
    inventoryLevels: {
      nodes: Array<{ location: { id: string }; quantities: Array<{ name: string; quantity: number }> }>;
    };
  } | null;
};
export type AdminProduct = { id: string; title: string; variants: { nodes: AdminVariant[] } };

export async function* fetchProducts(shopDomain: string): AsyncGenerator<AdminProduct> {
  const admin = await adminFor(shopDomain);
  let cursor: string | null = null;
  do {
    const data = await gql<{
      products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: AdminProduct[] };
    }>(
      admin,
      `#graphql
      query Products($cursor: String) {
        products(first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id title
            variants(first: 100) {
              nodes {
                id sku title
                inventoryItem {
                  id
                  unitCost { amount }
                  inventoryLevels(first: 50) {
                    nodes { location { id } quantities(names: ["available"]) { name quantity } }
                  }
                }
              }
            }
          }
        }
      }`,
      { cursor },
    );
    for (const node of data.products.nodes) yield node;
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);
}

export type AdminOrder = Parameters<typeof JSON.stringify>[0] & {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  displayFinancialStatus: string | null;
  currentTotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  currentSubtotalPriceSet: { shopMoney: { amount: string } };
  totalShippingPriceSet: { shopMoney: { amount: string } };
  currentTotalTaxSet: { shopMoney: { amount: string } };
  currentTotalDiscountsSet: { shopMoney: { amount: string } };
  lineItems: {
    nodes: Array<{
      id: string;
      quantity: number;
      variant: { id: string } | null;
      originalUnitPriceSet: { shopMoney: { amount: string } };
    }>;
  };
};

export async function* fetchRecentOrders(shopDomain: string, sinceISO: string): AsyncGenerator<AdminOrder> {
  const admin = await adminFor(shopDomain);
  let cursor: string | null = null;
  const search = `created_at:>=${sinceISO}`;
  do {
    const data = await gql<{
      orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: AdminOrder[] };
    }>(
      admin,
      `#graphql
      query Orders($cursor: String, $q: String!) {
        orders(first: 50, after: $cursor, query: $q, sortKey: CREATED_AT) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id name createdAt updatedAt displayFinancialStatus
            currentTotalPriceSet { shopMoney { amount currencyCode } }
            currentSubtotalPriceSet { shopMoney { amount } }
            totalShippingPriceSet { shopMoney { amount } }
            currentTotalTaxSet { shopMoney { amount } }
            currentTotalDiscountsSet { shopMoney { amount } }
            lineItems(first: 100) {
              nodes { id quantity variant { id } originalUnitPriceSet { shopMoney { amount } } }
            }
          }
        }
      }`,
      { cursor, q: search },
    );
    for (const node of data.orders.nodes) yield node;
    cursor = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (cursor);
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0. If the `AdminOrder` type's `Parameters<...>` intersection trips the compiler, replace it with a plain `export type AdminOrder = { ... }` (drop the `Parameters<typeof JSON.stringify>[0] &` prefix — it is only there to satisfy structural typing and is not required).

- [ ] **Step 3: Commit**

```bash
git add app/lib/ingest/shopify-admin.server.ts
git commit -m "feat(ingest): Admin GraphQL query layer (locations/products/orders)"
```

---

## Task 9: Backfill orchestrator

Resolves `shop_id`, walks the query layer, maps to fact rows, upserts on the confirmed natural keys. On any failure: DLQ + `sync_status='error'`.

**Files:**
- Create: `app/lib/ingest/backfill.server.ts`

- [ ] **Step 1: Implement the orchestrator**

`app/lib/ingest/backfill.server.ts`:

```ts
import { getSupabase, resolveShopId } from "../supabase.server";
import { writeDlq } from "./dlq.server";
import { fetchLocations, fetchProducts, fetchRecentOrders } from "./shopify-admin.server";
import { mapLocation, mapVariantToSku, mapOrder, mapOrderLines, gidToId } from "./mappers.server";
import type { InventoryRow } from "./types";

const BACKFILL_DAYS = 30;

export type BackfillResult = { shopDomain: string; locations: number; skus: number; inventory: number; orders: number };

export async function backfillShop(shopDomain: string): Promise<BackfillResult> {
  const sb = getSupabase();
  const shopId = await resolveShopId(shopDomain);
  const result: BackfillResult = { shopDomain, locations: 0, skus: 0, inventory: 0, orders: 0 };

  try {
    // 1. Locations
    const locations = (await fetchLocations(shopDomain)).map((n) => mapLocation(shopId, n));
    if (locations.length) {
      const { error } = await sb.from("location_dim").upsert(locations, { onConflict: "shop_id,external_id" });
      if (error) throw error;
      result.locations = locations.length;
    }
    // location external_id -> uuid map for inventory rows
    const { data: locRows, error: locErr } = await sb
      .from("location_dim")
      .select("id, external_id")
      .eq("shop_id", shopId);
    if (locErr) throw locErr;
    const locMap = new Map((locRows ?? []).map((r) => [r.external_id, r.id]));

    // 2. Products + variants + inventory
    const now = new Date().toISOString();
    for await (const product of fetchProducts(shopDomain)) {
      const skuRows = product.variants.nodes.map((v) => mapVariantToSku(shopId, product, v));
      if (!skuRows.length) continue;
      const { data: upserted, error: skuErr } = await sb
        .from("sku_dim")
        .upsert(skuRows, { onConflict: "shop_id,external_id" })
        .select("id, external_id");
      if (skuErr) throw skuErr;
      result.skus += upserted?.length ?? 0;
      const skuMap = new Map((upserted ?? []).map((r) => [r.external_id, r.id]));

      const invRows: InventoryRow[] = [];
      for (const v of product.variants.nodes) {
        const skuId = skuMap.get(v.id);
        if (!skuId) continue;
        for (const lvl of v.inventoryItem?.inventoryLevels.nodes ?? []) {
          const locId = locMap.get(lvl.location.id);
          if (!locId) continue;
          const available = lvl.quantities.find((q) => q.name === "available")?.quantity ?? 0;
          invRows.push({
            shop_id: shopId,
            sku_id: skuId,
            location_id: locId,
            available,
            observed_at: now,
            source_version: Date.parse(now),
          });
        }
      }
      if (invRows.length) {
        const { error: invErr } = await sb
          .from("inventory_level_fact")
          .upsert(invRows, { onConflict: "sku_id,location_id,source_version", ignoreDuplicates: true });
        if (invErr) throw invErr;
        result.inventory += invRows.length;
      }
    }

    // variant GID -> sku uuid map (for order lines)
    const { data: allSkus, error: allSkuErr } = await sb
      .from("sku_dim")
      .select("id, external_id")
      .eq("shop_id", shopId);
    if (allSkuErr) throw allSkuErr;
    const variantToSku = new Map((allSkus ?? []).map((r) => [r.external_id, r.id]));

    // 3. Orders (last 30 days)
    const since = new Date(Date.now() - BACKFILL_DAYS * 86_400_000).toISOString();
    for await (const order of fetchRecentOrders(shopDomain, since)) {
      const orderRow = mapOrder(shopId, order);
      const { data: oUp, error: oErr } = await sb
        .from("order_fact")
        .upsert(orderRow, { onConflict: "shop_id,external_id" })
        .select("id")
        .single();
      if (oErr) throw oErr;
      result.orders += 1;
      const lineRows = mapOrderLines(order).map((l) => ({
        shop_id: shopId,
        order_id: oUp.id,
        sku_id: l.sku_external_id ? variantToSku.get(l.sku_external_id) ?? null : null,
        external_line_id: l.external_line_id,
        quantity: l.quantity,
        price_cents: l.price_cents,
        total_cents: l.total_cents,
      }));
      if (lineRows.length) {
        const { error: lErr } = await sb
          .from("order_line_fact")
          .upsert(lineRows, { onConflict: "order_id,external_line_id" });
        if (lErr) throw lErr;
      }
    }

    await sb
      .from("shop_integrations")
      .update({ sync_status: "ready", sync_error: null, last_sync_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("shop_id", shopId)
      .eq("kind", "shopify");

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeDlq({ shopId, jobKind: "backfill", errorKind: "backfill_failed", errorMessage: message, payload: { shopDomain } });
    await sb
      .from("shop_integrations")
      .update({ sync_status: "error", sync_error: message.slice(0, 500), updated_at: new Date().toISOString() })
      .eq("shop_id", shopId)
      .eq("kind", "shopify");
    throw err;
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add app/lib/ingest/backfill.server.ts
git commit -m "feat(ingest): Shopify backfill orchestrator -> fact tables"
```

---

## Task 10: Transform worker (raw webhooks → facts)

Drains `raw_shopify_webhook WHERE processed_at IS NULL`, dispatches by topic, stamps `processed_at`. Failures → DLQ (and still stamped, so they don't loop).

**Files:**
- Create: `app/lib/ingest/transform.server.ts`

- [ ] **Step 1: Implement the worker**

`app/lib/ingest/transform.server.ts`:

```ts
import { getSupabase } from "../supabase.server";
import { writeDlq } from "./dlq.server";
import { parseInventoryWebhook, parseOrderWebhook } from "./mappers.server";

const BATCH = 200;

export type TransformResult = { processed: number; facts: number; dlq: number };

export async function transformPendingWebhooks(): Promise<TransformResult> {
  const sb = getSupabase();
  const res: TransformResult = { processed: 0, facts: 0, dlq: 0 };

  const { data: rows, error } = await sb
    .from("raw_shopify_webhook")
    .select("id, shop_id, topic, payload")
    .is("processed_at", null)
    .order("received_at", { ascending: true })
    .limit(BATCH);
  if (error) throw error;

  for (const row of rows ?? []) {
    try {
      if (row.topic === "inventory_levels/update") {
        res.facts += await applyInventory(row.shop_id, row.payload);
      } else if (row.topic === "orders/create") {
        res.facts += await applyOrder(row.shop_id, row.payload);
      }
      // products/update is handled by backfill upserts in Slice 1; skip here.
      await sb.from("raw_shopify_webhook").update({ processed_at: new Date().toISOString() }).eq("id", row.id);
      res.processed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await writeDlq({ shopId: row.shop_id, jobKind: `transform:${row.topic}`, errorKind: "transform_failed", errorMessage: message, payload: row.payload });
      await sb.from("raw_shopify_webhook").update({ processed_at: new Date().toISOString() }).eq("id", row.id);
      res.dlq += 1;
    }
  }
  return res;
}

async function applyInventory(shopId: string, payload: Record<string, unknown>): Promise<number> {
  const sb = getSupabase();
  const p = parseInventoryWebhook(payload);
  const { data: sku } = await sb
    .from("sku_dim")
    .select("id")
    .eq("shop_id", shopId)
    .eq("inventory_item_id", p.inventory_item_external_id)
    .maybeSingle();
  const { data: loc } = await sb
    .from("location_dim")
    .select("id")
    .eq("shop_id", shopId)
    .eq("external_id", p.location_external_id)
    .maybeSingle();
  if (!sku || !loc) throw new Error(`unresolved sku/location for inventory webhook (${p.inventory_item_external_id})`);
  const { error } = await sb
    .from("inventory_level_fact")
    .upsert(
      { shop_id: shopId, sku_id: sku.id, location_id: loc.id, available: p.available, observed_at: p.observed_at, source_version: p.source_version },
      { onConflict: "sku_id,location_id,source_version", ignoreDuplicates: true },
    );
  if (error) throw error;
  return 1;
}

async function applyOrder(shopId: string, payload: Record<string, unknown>): Promise<number> {
  const sb = getSupabase();
  const { order, lines } = parseOrderWebhook(payload as Record<string, never>);
  const { data: oUp, error: oErr } = await sb
    .from("order_fact")
    .upsert({ shop_id: shopId, ...order }, { onConflict: "shop_id,external_id" })
    .select("id")
    .single();
  if (oErr) throw oErr;
  if (!lines.length) return 1;
  const { data: skus } = await sb.from("sku_dim").select("id, external_id").eq("shop_id", shopId);
  const variantToSku = new Map((skus ?? []).map((r) => [r.external_id, r.id]));
  const lineRows = lines.map((l) => ({
    shop_id: shopId,
    order_id: oUp.id,
    sku_id: l.sku_external_id ? variantToSku.get(l.sku_external_id) ?? null : null,
    external_line_id: l.external_line_id,
    quantity: l.quantity,
    price_cents: l.price_cents,
    total_cents: l.total_cents,
  }));
  const { error: lErr } = await sb.from("order_line_fact").upsert(lineRows, { onConflict: "order_id,external_line_id" });
  if (lErr) throw lErr;
  return 1 + lineRows.length;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add app/lib/ingest/transform.server.ts
git commit -m "feat(ingest): transform worker draining raw_shopify_webhook into facts"
```

---

## Task 11: Detector DB runner (write + recover)

Reads `v_skus_flat`, computes average sell price, scores, then idempotently upserts alerts keyed on `sku_id` (select-then-write — robust against `entity_ref` jsonb equality changes), and resolves recovered SKUs.

**Files:**
- Modify: `app/lib/ingest/detectors/reorder-timing.server.ts`

- [ ] **Step 1: Append the DB runner**

Add to `app/lib/ingest/detectors/reorder-timing.server.ts`:

```ts
import { getSupabase } from "../../supabase.server";

export type DetectorRunResult = { upserted: number; resolved: number };

export async function runReorderTimingDetector(shopId: string, now = new Date()): Promise<DetectorRunResult> {
  const sb = getSupabase();

  // 1. Threshold (per-shop row, else defaults)
  const { data: thr } = await sb
    .from("alert_thresholds")
    .select("threshold_json")
    .eq("shop_id", shopId)
    .eq("detector_id", DETECTOR_ID)
    .maybeSingle();
  const threshold: ReorderThreshold = { ...DEFAULT_REORDER_THRESHOLD, ...((thr?.threshold_json as Partial<ReorderThreshold>) ?? {}) };

  // 2. SKUs from the flat view
  const { data: skuRows, error: skuErr } = await sb
    .from("v_skus_flat")
    .select("id, sku, title, on_hand, velocity, days_of_cover")
    .eq("shop_id", shopId);
  if (skuErr) throw skuErr;
  const skus: SkuFlat[] = (skuRows ?? []).map((r) => ({
    id: String(r.id),
    sku: (r.sku as string | null) ?? null,
    title: String(r.title),
    on_hand: Number(r.on_hand ?? 0),
    velocity: Number(r.velocity ?? 0),
    days_of_cover: Number(r.days_of_cover ?? 0),
  }));

  // 3. Average sell price per sku (cents) from recent order lines
  const avg: Record<string, number> = {};
  const { data: lines } = await sb
    .from("order_line_fact")
    .select("sku_id, price_cents")
    .eq("shop_id", shopId)
    .not("sku_id", "is", null);
  const acc: Record<string, { sum: number; n: number }> = {};
  for (const l of lines ?? []) {
    const k = String(l.sku_id);
    acc[k] ??= { sum: 0, n: 0 };
    acc[k].sum += Number(l.price_cents ?? 0);
    acc[k].n += 1;
  }
  for (const [k, v] of Object.entries(acc)) avg[k] = v.n ? Math.round(v.sum / v.n) : 0;

  const drafts = scoreReorderTiming(skus, avg, threshold, now);
  const dayBucket = now.toISOString().slice(0, 10);
  const breachingSkuIds = new Set(drafts.map((d) => d.sku_id));

  // 4. Upsert each draft (idempotent on sku_id within the day)
  let upserted = 0;
  for (const d of drafts) {
    const { data: existing } = await sb
      .from("alerts")
      .select("id")
      .eq("shop_id", shopId)
      .eq("detector_id", DETECTOR_ID)
      .eq("day_bucket", dayBucket)
      .eq("entity_ref->>sku_id", d.sku_id)
      .maybeSingle();

    if (existing) {
      await sb
        .from("alerts")
        .update({
          severity: d.severity,
          dollar_impact: d.dollar_impact,
          claude_rank: d.claude_rank,
          claude_narrative: d.claude_narrative,
          entity_ref: d.entity_ref,
          status: "open",
          last_seen_at: now.toISOString(),
          resolved_at: null,
        })
        .eq("id", existing.id);
      await sb.from("alert_context").upsert({ alert_id: existing.id, shop_id: shopId, evidence: d.evidence, created_at: now.toISOString() }, { onConflict: "alert_id" });
    } else {
      const { data: ins, error: insErr } = await sb
        .from("alerts")
        .insert({
          shop_id: shopId,
          detector_id: DETECTOR_ID,
          entity_ref: d.entity_ref,
          status: "open",
          severity: d.severity,
          dollar_impact: d.dollar_impact,
          day_bucket: dayBucket,
          claude_narrative: d.claude_narrative,
          claude_rank: d.claude_rank,
          first_seen_at: now.toISOString(),
          last_seen_at: now.toISOString(),
        })
        .select("id")
        .single();
      if (insErr) throw insErr;
      await sb.from("alert_context").insert({ alert_id: ins.id, shop_id: shopId, evidence: d.evidence, created_at: now.toISOString() });
    }
    upserted += 1;
  }

  // 5. Resolve open alerts whose sku no longer breaches
  const { data: openRows } = await sb
    .from("alerts")
    .select("id, entity_ref")
    .eq("shop_id", shopId)
    .eq("detector_id", DETECTOR_ID)
    .eq("status", "open");
  let resolved = 0;
  for (const r of openRows ?? []) {
    const skuId = (r.entity_ref as { sku_id?: string })?.sku_id;
    if (skuId && !breachingSkuIds.has(skuId)) {
      await sb.from("alerts").update({ status: "resolved", resolved_at: now.toISOString() }).eq("id", r.id);
      resolved += 1;
    }
  }

  return { upserted, resolved };
}
```

- [ ] **Step 2: Confirm the pure tests still pass (no behavior change to `scoreReorderTiming`)**

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: exit 0. If `.eq("entity_ref->>sku_id", ...)` is rejected by the supabase-js types, cast the filter via `.filter("entity_ref->>sku_id", "eq", d.sku_id)` instead.

- [ ] **Step 4: Commit**

```bash
git add app/lib/ingest/detectors/reorder-timing.server.ts
git commit -m "feat(ingest): reorder_timing DB runner with idempotent upsert + recovery"
```

---

## Task 12: Wire afterAuth + orders/create webhook

**Files:**
- Modify: `app/shopify.server.ts`
- Create: `app/routes/webhooks.orders.create.tsx`
- Modify: `shopify.app.calderynextension.toml`

- [ ] **Step 1: Enqueue backfill in `afterAuth`**

In `app/shopify.server.ts`, update the import and the `afterAuth` hook:

```ts
import { provisionShop } from "./lib/supabase.server";
import { enqueueShopifyBackfill } from "./lib/ingest/enqueue.server";
```

```ts
    afterAuth: async ({ session }) => {
      try {
        await provisionShop(session.shop);
        await enqueueShopifyBackfill(session.shop);
      } catch (err) {
        console.error(
          `[afterAuth] failed to provision/enqueue shop ${session.shop} in Supabase`,
          err,
        );
      }
    },
```

- [ ] **Step 2: Create the orders/create webhook handler**

`app/routes/webhooks.orders.create.tsx` (mirrors the existing handlers):

```tsx
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { CalderynError, calderynClient } from "~/lib/calderyn.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  try {
    await calderynClient(shop).internal.forwardWebhook(
      "/internal/webhooks/shopify/orders_create",
      payload,
      { "X-Shopify-Topic": topic },
    );
  } catch (err) {
    if (err instanceof CalderynError) {
      console.error(`Failed to forward orders/create for ${shop}: ${err.code} ${err.message}`);
    } else {
      console.error(`Failed to forward orders/create for ${shop}`, err);
    }
  }
  return new Response();
};
```

- [ ] **Step 3: Subscribe to the topic**

In `shopify.app.calderynextension.toml`, under `[webhooks]`, add:

```toml
  [[webhooks.subscriptions]]
  topics = [ "orders/create" ]
  uri = "/webhooks/orders/create"
```

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add app/shopify.server.ts app/routes/webhooks.orders.create.tsx shopify.app.calderynextension.toml
git commit -m "feat(ingest): enqueue backfill on install + orders/create webhook"
```

---

## Task 13: Cron route + Vercel schedule + env

One resource route runs all three phases in sequence, guarded by `CRON_SECRET`.

**Files:**
- Create: `app/routes/cron.ingest.tsx`
- Modify: `vercel.json`
- Modify: `.env.example`

- [ ] **Step 1: Create the cron route**

`app/routes/cron.ingest.tsx`:

```tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { getSupabase } from "~/lib/supabase.server";
import { backfillShop } from "~/lib/ingest/backfill.server";
import { transformPendingWebhooks } from "~/lib/ingest/transform.server";
import { runReorderTimingDetector } from "~/lib/ingest/detectors/reorder-timing.server";

const MAX_BACKFILL_SHOPS = 5; // bounded per tick to stay under function timeout

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const sb = getSupabase();
  const summary = {
    backfilled: [] as string[],
    backfillErrors: [] as string[],
    transform: { processed: 0, facts: 0, dlq: 0 },
    detect: { shops: 0, upserted: 0, resolved: 0 },
  };

  // Phase 1: backfill pending shops (bounded)
  const { data: pending } = await sb
    .from("shop_integrations")
    .select("shop_id, shops!inner(shop_domain)")
    .eq("kind", "shopify")
    .eq("sync_status", "pending")
    .limit(MAX_BACKFILL_SHOPS);
  for (const row of pending ?? []) {
    const domain = (row as unknown as { shops: { shop_domain: string } }).shops.shop_domain;
    try {
      await backfillShop(domain);
      summary.backfilled.push(domain);
    } catch {
      summary.backfillErrors.push(domain); // detail already in ingestion_dlq
    }
  }

  // Phase 2: transform queued webhooks
  summary.transform = await transformPendingWebhooks();

  // Phase 3: run the detector for every ready shop
  const { data: ready } = await sb
    .from("shop_integrations")
    .select("shop_id")
    .eq("kind", "shopify")
    .eq("sync_status", "ready");
  for (const r of ready ?? []) {
    const res = await runReorderTimingDetector(String(r.shop_id));
    summary.detect.shops += 1;
    summary.detect.upserted += res.upserted;
    summary.detect.resolved += res.resolved;
  }

  return json(summary);
};
```

- [ ] **Step 2: Add the cron schedule to `vercel.json`**

Add a `crons` array (note: Vercel Hobby allows once-daily crons; Pro allows arbitrary cadence — adjust `schedule` to your plan):

```json
{
  "framework": "remix",
  "buildCommand": "npm run build",
  "installCommand": "npm install && npx prisma generate",
  "regions": ["iad1"],
  "crons": [{ "path": "/cron/ingest", "schedule": "*/15 * * * *" }]
}
```

- [ ] **Step 3: Document `CRON_SECRET` in `.env.example`**

Add under the existing entries:

```
# Shared secret for authenticating Vercel Cron requests to /cron/ingest.
# 32+ random bytes (hex). Set the same value in Vercel project env.
CRON_SECRET=replace-with-32-byte-random-hex
```

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add app/routes/cron.ingest.tsx vercel.json .env.example
git commit -m "feat(ingest): cron route running backfill/transform/detect phases"
```

---

## Task 14: End-to-end verification on a dev shop + pre-commit gate

This task produces no new code — it proves the slice works on real data and runs the CLAUDE.md gate.

- [ ] **Step 1: Ensure env is set**

Confirm `.env` has `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, and a `CRON_SECRET`. The migration from Task 2 must be applied to the linked Supabase project.

- [ ] **Step 2: Trigger a fresh install / reauth**

Run `npm run dev`, open the app on a development store with real products/orders, and complete OAuth. This fires `afterAuth` → `enqueueShopifyBackfill`.

Verify the integration row is pending:

```sql
select kind, sync_status, last_sync_at from shop_integrations
where shop_id = (select id from shops where shop_domain = '<your-dev-shop>.myshopify.com');
```

Expected: `shopify | pending`.

- [ ] **Step 3: Run the cron once by hand**

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/cron/ingest | jq
```

Expected JSON shows the dev shop in `backfilled`, non-zero `detect.shops`.

- [ ] **Step 4: Verify facts populated (rule 12 — evidence, not assertion)**

```sql
select
  (select count(*) from sku_dim sd where sd.shop_id = s.id) as skus,
  (select count(*) from inventory_level_fact f where f.shop_id = s.id) as inv,
  (select count(*) from order_fact o where o.shop_id = s.id) as orders
from shops s where s.shop_domain = '<your-dev-shop>.myshopify.com';
```

Expected: non-zero counts matching the store's catalog/orders.

- [ ] **Step 5: Verify the view + alert render**

```sql
select id, title, on_hand, velocity, days_of_cover
from v_skus_flat where shop_id = (select id from shops where shop_domain = '<your-dev-shop>.myshopify.com')
order by days_of_cover asc limit 10;

select detector_id, severity, dollar_impact, claude_rank, entity_ref->>'title' as title
from v_alerts_view where shop_id = (select id from shops where shop_domain = '<your-dev-shop>.myshopify.com')
and detector_id = 'reorder_timing';
```

Expected: real SKUs in `v_skus_flat`; if any SKU has `days_of_cover < 14` and `velocity ≥ 0.1`, a matching `reorder_timing` row appears. Open the app's SKU and Alerts pages and confirm they render the same data.

- [ ] **Step 6: Verify idempotency**

Re-run Step 3. Expected: `sku_dim`/`order_fact` counts unchanged from Step 4; exactly one `reorder_timing` alert per breaching SKU for today (no duplicates).

- [ ] **Step 7: Run the full pre-commit gate (CLAUDE.md)**

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Paste the results. All must be green. Then run `/code-review` on the working tree and resolve blockers. `npx prisma validate` is **not** required (no `prisma/schema.prisma` change). `npm run graphql-codegen` is **not** required (queries are inline strings typed in the query layer, no `.graphql` files added).

- [ ] **Step 8: Final commit (if the gate produced fixes)**

```bash
git add -A
git commit -m "chore(ingest): pre-commit gate fixes for shopify ingestion slice"
```

---

## Self-Review

**Spec coverage:**
- §5 architecture (afterAuth enqueue → backfill cron → transform cron → detect) → Tasks 7, 9, 10, 11, 12, 13. ✓
- §6 backfill via Admin GraphQL (locations/products+inventory/30d orders) → Tasks 8, 9. ✓
- §7 transform raw→facts + idempotency keys → Task 10 (keys match the confirmed constraints exactly). ✓
- §7 orders/create subscription → Task 12. ✓
- §8 error handling / DLQ / sync_status=error → Tasks 7, 9, 10. ✓
- §9 detector scoring, severity bands, dollar_impact in dollars, claude_rank, narrative, entity_ref, evidence, day_bucket dedup, recovery → Tasks 6, 11. ✓
- §10 single required migration (`processed_at`); the proposed `alerts` index was dropped because the unique constraint already exists → Task 2 + this note. ✓
- §11 RLS surfaced, not fixed → no task (correctly out of scope). ✓
- §12 tests on pure mappers/parsers/scoring → Tasks 3, 4, 5, 6; idempotency + e2e → Task 14. ✓
- §13 deferred items (sku_velocity/stockout_forecast materialization) → intentionally not built; detector reads `v_skus_flat` directly. ✓

**Placeholder scan:** No TBD/TODO; every code step contains full code. Two steps (Task 4 Step 4, Task 8 Step 2, Task 11 Step 3) call out specific compiler-fallback edits rather than leaving them vague.

**Type consistency:** `AlertDraft`, `SkuFlat`, `ReorderThreshold`, `DETECTOR_ID`, `InventoryRow`/`OrderRow`/`OrderLineRow`, `parseInventoryWebhook`/`parseOrderWebhook`, `backfillShop`/`transformPendingWebhooks`/`runReorderTimingDetector` names are used identically across tasks and the cron route. Upsert `onConflict` strings match the verified DB constraints. `dollar_impact` is consistently dollars (numeric) end-to-end.
