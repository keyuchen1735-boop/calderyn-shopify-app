# Baseline insights for low-activity stores — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a baseline class of engine detectors that read catalog / inventory / cost (not orders) so a store with no sales or ads still gets useful, honest findings in the existing alerts list.

**Architecture:** Capture two more Shopify fields (variant price, product status) onto `sku_dim` during backfill. Add five new detectors to the existing Python engine that query `sku_dim` + `inventory_level_fact` instead of orders. They flow through the unchanged rank/narrate/alerts pipeline, so they appear in the existing "top alerts" list with no UI change. The "Money at risk" hero is untouched because baseline detectors never emit `critical`.

**Tech Stack:** Python 3 engine (asyncpg, pydantic v2, pytest), TypeScript/Remix backfill (Shopify Admin GraphQL, supabase-js), Supabase Postgres (hand-written SQL migrations).

## Global Constraints

- Baseline detectors MUST NOT emit `severity = "critical"` (only `high` / `medium` / `low`). This keeps the "Money at risk" hero, which sums critical `dollar_impact`, honest.
- No UI changes. The main page (`app/routes/app._index.tsx`) and dashboard are untouched.
- Money is stored as `*_cents integer`; convert to `Decimal` dollars at the SQL→Python boundary.
- `detector_id` is plain `text` — no enum migration needed for new ids.
- Engine detectors are `async def detect(shop_id, conn, now) -> list[DetectionResult]`, decorated `@register(DETECTOR_ID)`, and MUST be imported in `engine/calderyn_engine/pipeline.py` so the decorator runs.
- Each detector's testable logic is a **pure function** (no DB), mirroring `engine/tests/test_ad_tax_overload.py` which tests `select_ad_tax_offender` directly.
- Schema changes are hand-written timestamped SQL in `supabase/migrations/`, applied via Supabase (NOT Prisma — `sku_dim` is Supabase-managed). Testing is on prod Supabase (project `ajgrmnvzxfxxlwrxcgnu`); there is no staging.
- TypeScript is strict — no `any`.
- Pre-commit gate (CLAUDE.md): `npm run typecheck`, `npm run lint`, `npm run build`, plus `python -m pytest engine/tests -q` for engine changes; `npx prisma validate` is not applicable (Supabase-managed table).

---

### Task 1: Migration — add price + status columns to `sku_dim`

**Files:**
- Create: `supabase/migrations/20260625130000_sku_dim_price_status.sql`

**Interfaces:**
- Produces: two nullable `sku_dim` columns — `retail_price_cents integer`, `product_status text` (values `'active' | 'archived' | 'draft' | NULL`). Consumed by Task 2 (writer) and Tasks 4–8 (detectors).

- [ ] **Step 1: Write the migration**

```sql
-- Baseline insights for low-activity stores: capture Shopify variant retail
-- price and product status so catalog/inventory/margin detectors can run with
-- zero orders. Both nullable and additive — existing rows and the 14 existing
-- detectors are unaffected. unit_cost_cents + inventory_tracked already exist
-- (migration 20260624121000_shopify_inventory_settings.sql).
alter table public.sku_dim
  add column if not exists retail_price_cents integer
    check (retail_price_cents is null or retail_price_cents >= 0),
  add column if not exists product_status text
    check (product_status is null or product_status in ('active', 'archived', 'draft'));
```

- [ ] **Step 2: Apply the migration to Supabase**

Use the Supabase MCP `apply_migration` tool (name `sku_dim_price_status`, the SQL above) against project `ajgrmnvzxfxxlwrxcgnu`. Then verify:

Run (Supabase MCP `execute_sql`):
```sql
select column_name, data_type from information_schema.columns
where table_name = 'sku_dim' and column_name in ('retail_price_cents','product_status');
```
Expected: two rows (`retail_price_cents` integer, `product_status` text).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260625130000_sku_dim_price_status.sql
git commit -m "sku_dim: add retail_price_cents + product_status for baseline detectors"
```

---

### Task 2: Capture variant price + product status during backfill

**Files:**
- Modify: `app/lib/ingest/types.ts` (`SkuRow`)
- Modify: `app/lib/ingest/shopify-admin.server.ts` (`AdminProduct`, `AdminVariant`, `fetchProducts` query)
- Modify: `app/lib/ingest/mappers.server.ts` (`ProductNode`, `VariantNode`, `mapVariantToSku`, `parseProductWebhook` + its raw types)
- Test: `app/lib/ingest/__tests__/mappers.test.ts`

**Interfaces:**
- Consumes: Task 1 columns.
- Produces: `SkuRow` gains `retail_price_cents: number | null` and `product_status: string | null`; `mapVariantToSku` and `parseProductWebhook` populate them. The existing `backfill.server.ts` upsert and the transform worker write them automatically because they upsert the whole row object.

- [ ] **Step 1: Write the failing test**

Add to `app/lib/ingest/__tests__/mappers.test.ts`:

```ts
import { mapVariantToSku } from "../mappers.server";

describe("mapVariantToSku price + status", () => {
  const product = {
    id: "gid://shopify/Product/1",
    title: "Tee",
    status: "ACTIVE",
    vendor: null,
    productType: null,
    tags: [],
    collections: { nodes: [] },
  };
  const variant = {
    id: "gid://shopify/ProductVariant/9",
    sku: "TEE-1",
    title: "S",
    price: "24.00",
    inventoryPolicy: "DENY",
    inventoryItem: { id: "gid://shopify/InventoryItem/3", tracked: true, unitCost: { amount: "9.00" } },
  };

  it("captures retail price in cents and lowercased product status", () => {
    const row = mapVariantToSku("shop-1", product, variant);
    expect(row.retail_price_cents).toBe(2400);
    expect(row.product_status).toBe("active");
  });

  it("nulls retail price when absent", () => {
    const row = mapVariantToSku("shop-1", product, { ...variant, price: null });
    expect(row.retail_price_cents).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/ingest/__tests__/mappers.test.ts`
Expected: FAIL (`row.retail_price_cents` is `undefined`; `product_status` missing; TS error on `price`/`status`).

- [ ] **Step 3: Extend `SkuRow`**

In `app/lib/ingest/types.ts`, inside `SkuRow`, after `unit_cost_cents: number | null;` add:

```ts
  retail_price_cents: number | null;
  product_status: string | null;
```

- [ ] **Step 4: Add `price` + `status` to the GraphQL query and types**

In `app/lib/ingest/shopify-admin.server.ts`:

Add `status` to `AdminProduct`:
```ts
export type AdminProduct = {
  id: string;
  title: string;
  status: string | null;
  vendor: string | null;
  productType: string | null;
  tags: string[];
  collections: { nodes: Array<{ title: string }> };
  variants: { nodes: AdminVariant[] };
};
```

Add `price` to `AdminVariant` (near its `sku`/`title` fields):
```ts
  price: string | null;
```

In the `fetchProducts` query, change the product node selection `id title vendor productType tags` to include `status`:
```graphql
            id title status vendor productType tags
```
and the variant selection `id sku title inventoryPolicy` to include `price`:
```graphql
                id sku title inventoryPolicy price
```

- [ ] **Step 5: Map the new fields in `mapVariantToSku`**

In `app/lib/ingest/mappers.server.ts`, extend `ProductNode` with `status?: string | null;` and `VariantNode` with `price?: string | null;`. Then in `mapVariantToSku`, in the returned object after `unit_cost_cents: ...,` add:

```ts
    retail_price_cents: variant.price != null ? moneyToCents(variant.price) : null,
    product_status: product.status?.toLowerCase() ?? null,
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run app/lib/ingest/__tests__/mappers.test.ts`
Expected: PASS.

- [ ] **Step 7: Mirror onto the product webhook path**

So `products/update` keeps price/status fresh. In `app/lib/ingest/mappers.server.ts`:

- Add to `RawProductVariant`: `price?: string | null;`
- Add to `RawProductWebhook`: `status?: string | null;`
- Change `parseProductWebhook`'s return type from
  `Array<Omit<SkuRow, "shop_id" | "unit_cost_cents" | "collections">>` to
  `Array<Omit<SkuRow, "shop_id" | "unit_cost_cents" | "collections">>` with the
  new fields included (they are not in the Omit list, so just populate them):

  In the mapped variant object, after `inventory_tracked: ...,` add:
```ts
      retail_price_cents: variant.price != null ? moneyToCents(variant.price) : null,
      product_status: p.status?.toLowerCase() ?? null,
```

Add a webhook test in the same file mirroring Step 1 (a `parseProductWebhook` input with `status: "active"` and a variant `price: "24.00"`, asserting `retail_price_cents === 2400` and `product_status === "active"`).

- [ ] **Step 8: Run the full ingest suite + typecheck**

Run: `npx vitest run app/lib/ingest` then `npm run typecheck`
Expected: PASS, exit 0.

- [ ] **Step 9: Commit**

```bash
git add app/lib/ingest/types.ts app/lib/ingest/shopify-admin.server.ts app/lib/ingest/mappers.server.ts app/lib/ingest/__tests__/mappers.test.ts
git commit -m "ingest: capture variant price + product status onto sku_dim"
```

---

### Task 3: TypeScript labels for the five new detectors

**Files:**
- Modify: `app/lib/types.ts` (the `DetectorId` union)
- Modify: `app/lib/labels.ts` (`DETECTOR_LABELS`, `DETECTOR_TERMS`)
- Test: `app/lib/__tests__/baseline-labels.test.ts` (create)

**Interfaces:**
- Produces: plain-language labels so the existing alerts UI renders the new detector ids nicely. `detectorLabel(id)` already falls back to `humanizeDetectorId`, so this is polish + type-completeness, not a hard dependency for the engine.

- [ ] **Step 1: Write the failing test**

Create `app/lib/__tests__/baseline-labels.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { DETECTOR_LABELS, DETECTOR_TERMS } from "../labels";

const NEW_IDS = [
  "out_of_stock_live",
  "inventory_untracked",
  "priced_below_cost",
  "thin_margin",
  "missing_cost",
] as const;

describe("baseline detector labels", () => {
  it("has a plain label and a term for every new detector", () => {
    for (const id of NEW_IDS) {
      expect(DETECTOR_LABELS[id]).toBeTruthy();
      expect(DETECTOR_TERMS[id]).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/__tests__/baseline-labels.test.ts`
Expected: FAIL (keys missing; TS error indexing `DETECTOR_LABELS` with unknown ids).

- [ ] **Step 3: Extend the `DetectorId` union**

In `app/lib/types.ts`, find the `DetectorId` union type and add the five ids:
```ts
  | "out_of_stock_live"
  | "inventory_untracked"
  | "priced_below_cost"
  | "thin_margin"
  | "missing_cost"
```

- [ ] **Step 4: Add labels + terms**

In `app/lib/labels.ts`, add to `DETECTOR_LABELS`:
```ts
  out_of_stock_live: "Live product is out of stock",
  inventory_untracked: "Stock not being tracked",
  priced_below_cost: "Selling below cost",
  thin_margin: "Barely making a profit",
  missing_cost: "Add product costs to track profit",
```
and to `DETECTOR_TERMS`:
```ts
  out_of_stock_live: "Out-of-stock live SKU",
  inventory_untracked: "Untracked inventory",
  priced_below_cost: "Priced below cost",
  thin_margin: "Thin margin",
  missing_cost: "Missing cost coverage",
```

- [ ] **Step 5: Run the test + typecheck**

Run: `npx vitest run app/lib/__tests__/baseline-labels.test.ts` then `npm run typecheck`
Expected: PASS, exit 0.

> Note: `DETECTOR_LABELS` / `DETECTOR_TERMS` are `Record<DetectorId, string>`, so adding ids to the union makes those maps require the new keys (handled above). If typecheck flags any OTHER `Record<DetectorId, ...>` map (e.g. an icon or color map) now missing the five keys, add sensible entries there too — let the typecheck error list them rather than guessing up front.

- [ ] **Step 6: Commit**

```bash
git add app/lib/types.ts app/lib/labels.ts app/lib/__tests__/baseline-labels.test.ts
git commit -m "labels: plain-language labels for baseline detectors"
```

---

### Task 4: Detector — `out_of_stock_live`

**Files:**
- Create: `engine/calderyn_engine/detectors/out_of_stock_live.py`
- Create: `engine/tests/test_out_of_stock_live.py`
- Modify: `engine/calderyn_engine/pipeline.py` (import the new module)

**Interfaces:**
- Consumes: `sku_dim` (`product_status`, `inventory_tracked`), `inventory_level_fact` (`available`, `observed_at`).
- Produces: `out_of_stock_result(sku_id, sku, title, available) -> DetectionResult` (pure) and `@register("out_of_stock_live") async def detect(...)`.

- [ ] **Step 1: Write the failing test**

Create `engine/tests/test_out_of_stock_live.py`:

```python
from calderyn_engine.detectors.out_of_stock_live import out_of_stock_result


def test_builds_high_severity_result_with_sku_ref():
    r = out_of_stock_result("sku-1", "TEE-1", "Tee — S", 0)
    assert r.detector_id == "out_of_stock_live"
    assert r.severity == "high"
    assert r.entity_ref == {"sku_id": "sku-1", "sku": "TEE-1"}
    assert r.dollar_impact == 0
    assert r.evidence["available"] == "0"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest engine/tests/test_out_of_stock_live.py -q`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement the detector**

Create `engine/calderyn_engine/detectors/out_of_stock_live.py`:

```python
"""Detector: a live (published) product is out of stock and cannot be sold.

Catalog/inventory only — fires with zero orders. Sums the latest observed
``available`` per (sku, location) for tracked variants of active products and
flags any SKU whose total is at or below zero. dollar_impact is 0: with no
sales history there is no realized loss to claim, so the finding is an
opportunity, not "money at risk". Severity ``high`` (the listing literally
cannot convert), never ``critical``.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

import asyncpg

from calderyn_engine.detectors import register
from calderyn_engine.schemas import DetectionResult

DETECTOR_ID = "out_of_stock_live"

_QUERY = """
WITH latest AS (
    SELECT DISTINCT ON (sku_id, location_id) sku_id, available
    FROM public.inventory_level_fact
    WHERE shop_id = $1
    ORDER BY sku_id, location_id, observed_at DESC
),
totals AS (
    SELECT sku_id, sum(available)::numeric AS qty
    FROM latest
    GROUP BY sku_id
    HAVING sum(available) <= 0
)
SELECT t.sku_id, t.qty, d.sku AS sku_code, d.title AS sku_title
FROM totals t
JOIN public.sku_dim d ON d.id = t.sku_id
WHERE d.inventory_tracked IS TRUE
  AND d.product_status = 'active'
"""


def out_of_stock_result(sku_id, sku, title, available) -> DetectionResult:
    """Build the DetectionResult for one out-of-stock live SKU (pure)."""
    return DetectionResult(
        detector_id=DETECTOR_ID,
        entity_ref={"sku_id": str(sku_id), "sku": sku},
        severity="high",
        dollar_impact=Decimal("0"),
        evidence={"available": str(int(available)), "sku_title": title},
    )


@register(DETECTOR_ID)
async def detect(
    shop_id: str, conn: asyncpg.Connection, now: datetime
) -> list[DetectionResult]:
    rows = await conn.fetch(_QUERY, shop_id)
    return [
        out_of_stock_result(r["sku_id"], r["sku_code"], r["sku_title"], r["qty"])
        for r in rows
    ]
```

- [ ] **Step 4: Register the module by importing it in the pipeline**

In `engine/calderyn_engine/pipeline.py`, in the `from calderyn_engine.detectors import (...)` block (the one with the `# noqa: E402, F401` comment), add `out_of_stock_live,` alphabetically near the other inventory detectors.

- [ ] **Step 5: Run the test to verify it passes**

Run: `python -m pytest engine/tests/test_out_of_stock_live.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add engine/calderyn_engine/detectors/out_of_stock_live.py engine/tests/test_out_of_stock_live.py engine/calderyn_engine/pipeline.py
git commit -m "engine: out_of_stock_live baseline detector"
```

---

### Task 5: Detector — `inventory_untracked`

**Files:**
- Create: `engine/calderyn_engine/detectors/inventory_untracked.py`
- Create: `engine/tests/test_inventory_untracked.py`
- Modify: `engine/calderyn_engine/pipeline.py` (import)

**Interfaces:**
- Consumes: `sku_dim` (`inventory_tracked`, `product_status`).
- Produces: `untracked_result(sku_id, sku, title) -> DetectionResult` (pure) and `@register("inventory_untracked") async def detect(...)`.

- [ ] **Step 1: Write the failing test**

Create `engine/tests/test_inventory_untracked.py`:

```python
from calderyn_engine.detectors.inventory_untracked import untracked_result


def test_builds_low_severity_result():
    r = untracked_result("sku-9", "MUG-1", "Mug")
    assert r.detector_id == "inventory_untracked"
    assert r.severity == "low"
    assert r.entity_ref == {"sku_id": "sku-9", "sku": "MUG-1"}
    assert r.dollar_impact == 0
    assert r.evidence["sku_title"] == "Mug"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest engine/tests/test_inventory_untracked.py -q`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement the detector**

Create `engine/calderyn_engine/detectors/inventory_untracked.py`:

```python
"""Detector: a live product is not tracking inventory.

Catalog only — fires with zero orders. Flags active products whose variant has
Shopify inventory tracking off, so the merchant is flying blind on stock and
can oversell. dollar_impact 0, severity ``low`` (a hygiene nudge, not a loss).
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

import asyncpg

from calderyn_engine.detectors import register
from calderyn_engine.schemas import DetectionResult

DETECTOR_ID = "inventory_untracked"

_QUERY = """
SELECT id AS sku_id, sku AS sku_code, title AS sku_title
FROM public.sku_dim
WHERE shop_id = $1
  AND inventory_tracked IS FALSE
  AND product_status = 'active'
"""


def untracked_result(sku_id, sku, title) -> DetectionResult:
    """Build the DetectionResult for one untracked live SKU (pure)."""
    return DetectionResult(
        detector_id=DETECTOR_ID,
        entity_ref={"sku_id": str(sku_id), "sku": sku},
        severity="low",
        dollar_impact=Decimal("0"),
        evidence={"sku_title": title},
    )


@register(DETECTOR_ID)
async def detect(
    shop_id: str, conn: asyncpg.Connection, now: datetime
) -> list[DetectionResult]:
    rows = await conn.fetch(_QUERY, shop_id)
    return [
        untracked_result(r["sku_id"], r["sku_code"], r["sku_title"]) for r in rows
    ]
```

- [ ] **Step 4: Import in the pipeline**

Add `inventory_untracked,` to the detector import block in `engine/calderyn_engine/pipeline.py`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `python -m pytest engine/tests/test_inventory_untracked.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add engine/calderyn_engine/detectors/inventory_untracked.py engine/tests/test_inventory_untracked.py engine/calderyn_engine/pipeline.py
git commit -m "engine: inventory_untracked baseline detector"
```

---

### Task 6: Shared margin helper + `priced_below_cost` detector

**Files:**
- Create: `engine/calderyn_engine/detectors/_margin.py`
- Create: `engine/calderyn_engine/detectors/priced_below_cost.py`
- Create: `engine/tests/test_margin.py`
- Modify: `engine/calderyn_engine/pipeline.py` (import)

**Interfaces:**
- Consumes: `sku_dim` (`retail_price_cents`, `unit_cost_cents`).
- Produces: `classify_margin(price_cents, cost_cents, thin_pct) -> "below_cost" | "thin" | "ok"` and `per_unit_loss_dollars(price_cents, cost_cents) -> Decimal` in `_margin.py` (both pure, both reused by Task 7); `@register("priced_below_cost") async def detect(...)`.

- [ ] **Step 1: Write the failing test**

Create `engine/tests/test_margin.py`:

```python
from decimal import Decimal

from calderyn_engine.detectors._margin import classify_margin, per_unit_loss_dollars

THIN = Decimal("0.15")


def test_below_cost_when_cost_exceeds_price():
    assert classify_margin(2000, 2500, THIN) == "below_cost"


def test_thin_when_margin_under_threshold():
    # price 100.00, cost 90.00 -> 10% margin < 15%
    assert classify_margin(10000, 9000, THIN) == "thin"


def test_ok_when_margin_healthy():
    assert classify_margin(10000, 5000, THIN) == "ok"


def test_ok_when_no_price():
    assert classify_margin(0, 5000, THIN) == "ok"


def test_per_unit_loss_is_positive_dollars():
    assert per_unit_loss_dollars(2000, 2500) == Decimal("5.00")
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest engine/tests/test_margin.py -q`
Expected: FAIL (`_margin` module missing).

- [ ] **Step 3: Implement the margin helper**

Create `engine/calderyn_engine/detectors/_margin.py`:

```python
"""Pure margin classification shared by the catalog margin detectors.

Operates on integer cents (the storage unit) and returns dollars as Decimal
only where a money figure is surfaced. No DB, no I/O — unit-tested directly.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Literal

MarginClass = Literal["below_cost", "thin", "ok"]


def classify_margin(price_cents: int, cost_cents: int, thin_pct: Decimal) -> MarginClass:
    """Classify a SKU by gross margin. ``thin_pct`` is a fraction (0.15 = 15%)."""
    if price_cents <= 0:
        return "ok"  # no price to judge against
    if cost_cents > price_cents:
        return "below_cost"
    margin = Decimal(price_cents - cost_cents) / Decimal(price_cents)
    return "thin" if margin < thin_pct else "ok"


def per_unit_loss_dollars(price_cents: int, cost_cents: int) -> Decimal:
    """Loss per sale in dollars when a SKU is priced below cost (>= 0)."""
    return (Decimal(cost_cents) - Decimal(price_cents)) / Decimal("100")
```

- [ ] **Step 4: Run the helper test to verify it passes**

Run: `python -m pytest engine/tests/test_margin.py -q`
Expected: PASS.

- [ ] **Step 5: Implement the `priced_below_cost` detector**

Create `engine/calderyn_engine/detectors/priced_below_cost.py`:

```python
"""Detector: a SKU's retail price is below its unit cost — a loss on every sale.

Catalog only — fires with zero orders. dollar_impact is the per-unit loss
(cost − price), shown by the UI as the row's money figure. Severity ``high``,
never ``critical`` (no realized bleed yet on a store with no sales).
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

import asyncpg

from calderyn_engine.detectors import register
from calderyn_engine.detectors._margin import classify_margin, per_unit_loss_dollars
from calderyn_engine.schemas import DetectionResult

DETECTOR_ID = "priced_below_cost"
_THIN_PCT = Decimal("0.15")

_QUERY = """
SELECT id AS sku_id, sku AS sku_code, title AS sku_title,
       retail_price_cents, unit_cost_cents
FROM public.sku_dim
WHERE shop_id = $1
  AND retail_price_cents IS NOT NULL
  AND unit_cost_cents IS NOT NULL
  AND retail_price_cents > 0
"""


@register(DETECTOR_ID)
async def detect(
    shop_id: str, conn: asyncpg.Connection, now: datetime
) -> list[DetectionResult]:
    rows = await conn.fetch(_QUERY, shop_id)
    out: list[DetectionResult] = []
    for r in rows:
        price, cost = int(r["retail_price_cents"]), int(r["unit_cost_cents"])
        if classify_margin(price, cost, _THIN_PCT) != "below_cost":
            continue
        out.append(
            DetectionResult(
                detector_id=DETECTOR_ID,
                entity_ref={"sku_id": str(r["sku_id"]), "sku": r["sku_code"]},
                severity="high",
                dollar_impact=per_unit_loss_dollars(price, cost),
                evidence={
                    "sku_title": r["sku_title"],
                    "price_usd": str(Decimal(price) / Decimal("100")),
                    "cost_usd": str(Decimal(cost) / Decimal("100")),
                },
            )
        )
    return out
```

- [ ] **Step 6: Import in the pipeline**

Add `priced_below_cost,` to the detector import block in `engine/calderyn_engine/pipeline.py`.

- [ ] **Step 7: Run the engine suite to verify nothing broke**

Run: `python -m pytest engine/tests -q`
Expected: PASS (all engine tests).

- [ ] **Step 8: Commit**

```bash
git add engine/calderyn_engine/detectors/_margin.py engine/calderyn_engine/detectors/priced_below_cost.py engine/tests/test_margin.py engine/calderyn_engine/pipeline.py
git commit -m "engine: priced_below_cost baseline detector + shared margin helper"
```

---

### Task 7: Detector — `thin_margin`

**Files:**
- Create: `engine/calderyn_engine/detectors/thin_margin.py`
- Create: `engine/tests/test_thin_margin.py`
- Modify: `engine/calderyn_engine/pipeline.py` (import)

**Interfaces:**
- Consumes: `sku_dim` (`retail_price_cents`, `unit_cost_cents`), `_margin.classify_margin`.
- Produces: `thin_margin_result(sku_id, sku, title, price_cents, cost_cents) -> DetectionResult` (pure) and `@register("thin_margin") async def detect(...)`.

- [ ] **Step 1: Write the failing test**

Create `engine/tests/test_thin_margin.py`:

```python
from calderyn_engine.detectors.thin_margin import thin_margin_result


def test_builds_medium_severity_with_margin_pct():
    r = thin_margin_result("sku-2", "HAT-1", "Hat", 10000, 9000)
    assert r.detector_id == "thin_margin"
    assert r.severity == "medium"
    assert r.dollar_impact == 0
    assert r.evidence["margin_pct"] == "10"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest engine/tests/test_thin_margin.py -q`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement the detector**

Create `engine/calderyn_engine/detectors/thin_margin.py`:

```python
"""Detector: a SKU's margin is positive but razor-thin (below 15%).

Catalog only — fires with zero orders. dollar_impact 0 (the risk is fragility,
not a current loss); the margin percent rides in evidence. Severity ``medium``.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP

import asyncpg

from calderyn_engine.detectors import register
from calderyn_engine.detectors._margin import classify_margin
from calderyn_engine.schemas import DetectionResult

DETECTOR_ID = "thin_margin"
_THIN_PCT = Decimal("0.15")

_QUERY = """
SELECT id AS sku_id, sku AS sku_code, title AS sku_title,
       retail_price_cents, unit_cost_cents
FROM public.sku_dim
WHERE shop_id = $1
  AND retail_price_cents IS NOT NULL
  AND unit_cost_cents IS NOT NULL
  AND retail_price_cents > 0
"""


def thin_margin_result(sku_id, sku, title, price_cents, cost_cents) -> DetectionResult:
    """Build the DetectionResult for one thin-margin SKU (pure)."""
    margin_pct = (
        (Decimal(price_cents - cost_cents) / Decimal(price_cents) * Decimal("100"))
        .quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    )
    return DetectionResult(
        detector_id=DETECTOR_ID,
        entity_ref={"sku_id": str(sku_id), "sku": sku},
        severity="medium",
        dollar_impact=Decimal("0"),
        evidence={
            "sku_title": title,
            "margin_pct": str(margin_pct),
            "price_usd": str(Decimal(price_cents) / Decimal("100")),
            "cost_usd": str(Decimal(cost_cents) / Decimal("100")),
        },
    )


@register(DETECTOR_ID)
async def detect(
    shop_id: str, conn: asyncpg.Connection, now: datetime
) -> list[DetectionResult]:
    rows = await conn.fetch(_QUERY, shop_id)
    out: list[DetectionResult] = []
    for r in rows:
        price, cost = int(r["retail_price_cents"]), int(r["unit_cost_cents"])
        if classify_margin(price, cost, _THIN_PCT) != "thin":
            continue
        out.append(
            thin_margin_result(r["sku_id"], r["sku_code"], r["sku_title"], price, cost)
        )
    return out
```

- [ ] **Step 4: Import in the pipeline**

Add `thin_margin,` to the detector import block in `engine/calderyn_engine/pipeline.py`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `python -m pytest engine/tests/test_thin_margin.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add engine/calderyn_engine/detectors/thin_margin.py engine/tests/test_thin_margin.py engine/calderyn_engine/pipeline.py
git commit -m "engine: thin_margin baseline detector"
```

---

### Task 8: Detector — `missing_cost` (shop-level)

**Files:**
- Create: `engine/calderyn_engine/detectors/missing_cost.py`
- Create: `engine/tests/test_missing_cost.py`
- Modify: `engine/calderyn_engine/pipeline.py` (import)

**Interfaces:**
- Consumes: `sku_dim` (`unit_cost_cents`, `product_status`).
- Produces: `missing_cost_result(count, total) -> DetectionResult | None` (pure, `None` when count is 0) and `@register("missing_cost") async def detect(...)`. Emits at most ONE shop-scoped alert (`entity_ref = {"scope": "shop"}`) so a fresh store with no costs gets one nudge, not one row per SKU.

- [ ] **Step 1: Write the failing test**

Create `engine/tests/test_missing_cost.py`:

```python
from calderyn_engine.detectors.missing_cost import missing_cost_result


def test_summarizes_missing_cost_count_shop_level():
    r = missing_cost_result(12, 26)
    assert r is not None
    assert r.detector_id == "missing_cost"
    assert r.severity == "low"
    assert r.entity_ref == {"scope": "shop"}
    assert r.dollar_impact == 0
    assert r.evidence == {"count": "12", "total": "26"}


def test_no_alert_when_all_costs_present():
    assert missing_cost_result(0, 26) is None
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest engine/tests/test_missing_cost.py -q`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement the detector**

Create `engine/calderyn_engine/detectors/missing_cost.py`:

```python
"""Detector: active products with no unit cost set (one shop-level nudge).

Catalog only — fires with zero orders. Without cost, the margin detectors
(and the order-based margin engine later) cannot protect the merchant, so this
is the activation nudge to fill costs in. One shop-scoped alert summarizing the
count, never one row per SKU. dollar_impact 0, severity ``low``.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

import asyncpg

from calderyn_engine.detectors import register
from calderyn_engine.schemas import DetectionResult

DETECTOR_ID = "missing_cost"

_QUERY = """
SELECT
    count(*) FILTER (WHERE unit_cost_cents IS NULL) AS missing,
    count(*) AS total
FROM public.sku_dim
WHERE shop_id = $1
  AND product_status = 'active'
"""


def missing_cost_result(count: int, total: int) -> DetectionResult | None:
    """Build the shop-level DetectionResult, or None when nothing is missing."""
    if count <= 0:
        return None
    return DetectionResult(
        detector_id=DETECTOR_ID,
        entity_ref={"scope": "shop"},
        severity="low",
        dollar_impact=Decimal("0"),
        evidence={"count": str(count), "total": str(total)},
    )


@register(DETECTOR_ID)
async def detect(
    shop_id: str, conn: asyncpg.Connection, now: datetime
) -> list[DetectionResult]:
    row = await conn.fetchrow(_QUERY, shop_id)
    result = missing_cost_result(int(row["missing"]), int(row["total"]))
    return [result] if result is not None else []
```

- [ ] **Step 4: Import in the pipeline**

Add `missing_cost,` to the detector import block in `engine/calderyn_engine/pipeline.py`.

- [ ] **Step 5: Run the full engine suite**

Run: `python -m pytest engine/tests -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add engine/calderyn_engine/detectors/missing_cost.py engine/tests/test_missing_cost.py engine/calderyn_engine/pipeline.py
git commit -m "engine: missing_cost baseline detector (shop-level nudge)"
```

---

### Task 9: Full-gate verification + live check

**Files:** none (verification only)

- [ ] **Step 1: Run the whole pre-commit gate**

Run, in order, and confirm each is green:
```
npm run typecheck
npm run lint
npm run build
npm run test
python -m pytest engine/tests -q
```

- [ ] **Step 2: Backfill the new columns for the test store**

The new `retail_price_cents` / `product_status` are only populated on the next backfill. Re-trigger ingest for `calderyn-test` (re-open the app, or wait for `/cron/ingest`), then verify with Supabase MCP `execute_sql`:
```sql
select count(*) filter (where retail_price_cents is not null) as priced,
       count(*) filter (where product_status = 'active') as active,
       count(*) filter (where unit_cost_cents is null) as missing_cost
from sku_dim s join shops sh on sh.id = s.shop_id
where sh.shop_domain = 'calderyn-test.myshopify.com';
```
Expected: `priced` > 0 and `active` > 0 (proves capture works).

- [ ] **Step 3: Run the engine for the test store and confirm baseline alerts**

After deploy, let `/cron/detect` run (or POST `/api/engine/run` with the shop_id). Then:
```sql
select detector_id, count(*) from alerts a
join shops sh on sh.id = a.shop_id
where sh.shop_domain = 'calderyn-test.myshopify.com' and a.status = 'open'
group by detector_id;
```
Expected: at least `missing_cost` (and any inventory/margin findings) present. Confirm the main page now shows a populated "top alerts" list while "Money at risk" stays unchanged.

---

## Notes for the implementer

- **Alert lifecycle:** there is no engine-side auto-resolve sweep; baseline alerts behave exactly like the existing 14 detectors' alerts (refresh while the condition holds via the active-condition dedup index; merchant acknowledges/dismisses otherwise). Do not add a bespoke resolution path — match existing behavior.
- **Why no DB tests for `detect()`:** the engine test convention (see `engine/tests/test_ad_tax_overload.py`) unit-tests pure functions, not the SQL wrappers. Keep all branching logic in the pure helpers so coverage lives there.
- **Severity discipline:** never emit `critical` from a baseline detector — that is the single rule protecting the honest "Money at risk" hero.
- **Sequencing:** Tasks 4–5 (inventory) deliver value with no cost data and can ship before Tasks 6–8 (margin) if you want to split the PR.
