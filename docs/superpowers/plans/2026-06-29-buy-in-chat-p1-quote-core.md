# Buy-in-Chat P1 — Quote Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the single source-of-truth `quoteCart()` (subtotal + real `#6.3` shipping + Stripe Tax), persist locked quotes in `commerce_quote_fact`, expose `getAgenticCatalog()`, and wire the quote into checkout so it stops reporting flat $0 shipping/tax.

**Architecture:** A new protocol-neutral `app/lib/commerce/` module. Pricing is extracted from `cart.server.ts` into a shared `priceLines()` so cart, checkout, and agentic surfaces price identically. `quoteCart()` is the only function that computes shipping+tax; it calls the existing `#6.3` engine (`getShippingEngine`) with a ship-from origin resolved from Shopify (require-setup if absent) and Stripe Tax for tax. Quotes are locked into an append-only `commerce_quote_fact` row with an expiry so a re-presented quote never re-prices.

**Tech Stack:** TypeScript (strict, ESM), Remix, Supabase Postgres via `getSupabase()` (service-role), the EasyPost rate adapter, Stripe SDK v22 (`tax.calculations`), Vitest.

**Parent spec:** `docs/superpowers/specs/2026-06-29-buy-in-chat-design.md` (§5, §6). This is plan **P1 of 4** (P2 MCP adapter, P3 ACP adapter, P4 storefront/dashboard depend on it).

**Conventions to follow (read before starting):**
- Money is integer **cents** everywhere. Currency is lowercase ISO-4217 on owned tables (`usd`), uppercase only in the warehouse.
- Server-only files end `.server.ts`. The app reaches Postgres only via `getSupabase()` (service-role); always pass `shop_id` explicitly on every read/write.
- Tests are colocated `*.test.ts` (or under `__tests__/`) and run with `npx vitest run <path>`.
- Fail visibly (rule 12): never substitute a fake value for missing data — throw a typed error.

---

## File structure

| File | Responsibility | Create/Modify |
|---|---|---|
| `supabase/migrations/<ts>_commerce_quote_core.sql` | `commerce_quote_fact` table, `v_agentic_catalog` view, `shop_origin` table | Create |
| `app/lib/order/cart.server.ts` | extract shared `priceLines()`; `priceCart` delegates to it | Modify |
| `app/lib/commerce/types.ts` | shared commerce types (`QuoteLine`, `CartQuote`, `QuoteDestination`) | Create |
| `app/lib/commerce/origin.server.ts` | `getShopOrigin(shopId)` — stored → Shopify pull → require-setup | Create |
| `app/lib/commerce/rate-source.server.ts` | `getRateSource(shopId)` — EasyPost `RateQuoteSource` | Create |
| `app/lib/commerce/tax.server.ts` | `calculateTax()` — Stripe Tax wrapper | Create |
| `app/lib/commerce/quote.server.ts` | `quoteCart(shopId, lines, destination)` — the accuracy spine | Create |
| `app/lib/commerce/quote-store.server.ts` | `lockQuote()` / `getQuote()` over `commerce_quote_fact` | Create |
| `app/lib/commerce/catalog.server.ts` | `getAgenticCatalog(shopId)` over `v_agentic_catalog` | Create |
| `app/lib/order/checkout.server.ts` | replace `PILOT_FLAT_*` with `quoteCart` totals | Modify |

---

## Task 1: Migration — quote table, catalog view, origin table

**Files:**
- Create: `supabase/migrations/<timestamp>_commerce_quote_core.sql` (use the next timestamp after the latest existing migration, format `YYYYMMDDHHMMSS`)

- [ ] **Step 1: Write the migration**

```sql
-- commerce_quote_fact: append-only LOCKED quotes. A re-presented quote_id is the SAME
-- quote (no re-price drift) — the "no second chance" guarantee for agentic surfaces.
create table if not exists commerce_quote_fact (
  shop_id          text        not null,
  quote_id         uuid        not null default gen_random_uuid(),
  client_id        text,
  line_items       jsonb       not null,
  subtotal_cents   integer     not null,
  shipping_cents   integer     not null,
  tax_cents        integer     not null,
  total_cents      integer     not null,
  currency         text        not null,
  destination_hash text        not null,
  source_version   integer     not null default 1,
  low_confidence   boolean     not null default false,
  fallback_used    boolean     not null default false,
  expires_at       timestamptz not null,
  created_at       timestamptz not null default now(),
  primary key (quote_id, source_version)
);
create index if not exists idx_commerce_quote_fact_shop on commerce_quote_fact (shop_id, created_at desc);

-- shop_origin: merchant ship-from. Populated from Shopify shop.billingAddress on first
-- quote, or set by the merchant. Absent/incomplete => quoting fails visibly (ORIGIN_NOT_CONFIGURED).
create table if not exists shop_origin (
  shop_id    text        primary key,
  name       text,
  street1    text        not null,
  street2    text,
  city       text        not null,
  state      text        not null,
  zip        text        not null,
  country    text        not null default 'US',
  source     text        not null default 'shopify', -- 'shopify' | 'merchant'
  updated_at timestamptz not null default now()
);

-- v_agentic_catalog: product-feed projection over the owned catalog. sku_dim carries
-- retail_price_cents + category/vendor; inventory_level_fact carries on-hand. Out-of-stock
-- (tracked AND on_hand <= 0) is excluded so an agent never quotes an unbuyable SKU.
create or replace view v_agentic_catalog as
select
  s.shop_id,
  s.variant_external_id           as variant_id,
  s.product_title,
  s.variant_title,
  s.retail_price_cents,
  s.currency,
  s.vendor,
  s.category,
  s.tags,
  coalesce(i.on_hand, 0)          as on_hand,
  s.inventory_tracked,
  s.inventory_policy
from sku_dim s
left join inventory_level_fact i
  on i.shop_id = s.shop_id and i.variant_external_id = s.variant_external_id
where not (s.inventory_tracked and coalesce(i.on_hand, 0) <= 0
           and s.inventory_policy = 'deny');
```

> **Before writing:** open the latest `supabase/migrations/*_order_spine.sql` and the `sku_dim` / `inventory_level_fact` migrations to confirm the **exact** column names used above (`variant_external_id`, `retail_price_cents`, `on_hand`, `inventory_tracked`, `inventory_policy`, `category`, `tags`). Adjust the view's column references to match the real schema — do not invent columns. If a referenced column does not exist, use the closest real one and note it in the migration comment.

- [ ] **Step 2: Apply and validate**

Run: `npx supabase migration up` (or the repo's migration command) then `npx supabase db lint` if available.
Expected: migration applies; `select * from v_agentic_catalog limit 1;` and `select * from commerce_quote_fact limit 1;` resolve without error.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/
git commit -m "commerce: quote_fact + v_agentic_catalog + shop_origin schema (buy-in-chat P1)"
```

---

## Task 2: Shared commerce types

**Files:**
- Create: `app/lib/commerce/types.ts`

- [ ] **Step 1: Write the types**

```typescript
// app/lib/commerce/types.ts
// Protocol-neutral commerce types shared by quote, order, and the adapters (P2/P3).
import type { Address } from "~/lib/ship-cost/adapters/rate-quote";

/** One line an agent (or checkout) wants quoted: a variant + quantity. */
export interface QuoteLine {
  variantId: string;
  quantity: number;
}

/** A priced line after catalog resolution (snapshot of what the buyer is shown). */
export interface PricedLine extends QuoteLine {
  unitPriceCents: number;
  currency: string;
  titleSnapshot: string;
}

/** The ship-to address. Reuses the engine's Address shape (street1/city/state/zip/country). */
export type QuoteDestination = Address;

/** The canonical quote returned by quoteCart() — the single source of truth. Money in cents. */
export interface CartQuote {
  lines: PricedLine[];
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  currency: string;
  deliveryEarliest: string | null; // ISO-8601
  deliveryLatest: string | null;
  lowConfidence: boolean; // shipping had to guess dims/weight (rule 12)
  fallbackUsed: boolean; // shipping degraded to static fallback (rule 12)
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no errors from the new file).

- [ ] **Step 3: Commit**

```bash
git add app/lib/commerce/types.ts
git commit -m "commerce: shared quote types (buy-in-chat P1)"
```

---

## Task 3: Extract shared `priceLines()` from cart pricing

**Why:** cart, checkout, and the agentic quote must price a variant list identically. `cart.server.ts` already resolves a variant and snapshots `priceCents`/`currency`/`titleSnapshot`. Extract that into one reusable function so `quoteCart` reuses it (DRY) instead of re-deriving prices.

**Files:**
- Modify: `app/lib/order/cart.server.ts`
- Test: `app/lib/order/cart.server.test.ts` (existing)

- [ ] **Step 1: Write a failing test for `priceLines`**

Add to `app/lib/order/cart.server.test.ts`:

```typescript
import { priceLines } from "./cart.server";

it("priceLines snapshots catalog price + currency + title for each variant", async () => {
  // Uses the same catalog stub the other cart tests use (getCatalog() stub).
  const result = await priceLines("shop_test", [
    { variantId: "VARIANT_A", quantity: 2 },
  ]);
  expect(result.subtotalCents).toBe(result.lines[0].unitPriceCents * 2);
  expect(result.currency).toBe(result.lines[0].currency);
  expect(result.lines[0].titleSnapshot).toBeTruthy();
});
```

> Read the top of the existing test file to reuse its catalog-stub setup (the same fixture `addCartLine`/`priceCart` tests use). Replace `VARIANT_A` with a real fixture variant id.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run app/lib/order/cart.server.test.ts -t "priceLines"`
Expected: FAIL — `priceLines is not exported`.

- [ ] **Step 3: Extract `priceLines` and re-point `priceCart`/`addCartLine`**

In `app/lib/order/cart.server.ts` add (reusing the existing private `resolveVariant` + `snapshotTitle`):

```typescript
import type { QuoteLine, PricedLine } from "~/lib/commerce/types";

/**
 * Price a list of (variant, quantity) against the live catalog — the single pricing path
 * shared by cart add, checkout, and agentic quotes. Throws (rule 12) on an unknown or
 * unavailable variant rather than silently dropping it. Mixed currencies fail visibly.
 */
export async function priceLines(
  shopId: string,
  lines: QuoteLine[],
): Promise<{ lines: PricedLine[]; subtotalCents: number; currency: string }> {
  if (!shopId) throw new Error("shopId is required");
  const priced: PricedLine[] = [];
  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new Error(`quantity must be a positive integer, got ${line.quantity}`);
    }
    const resolved = await resolveVariant(shopId, line.variantId);
    if (!resolved) throw new Error(`variant ${line.variantId} not found in catalog for shop ${shopId}`);
    if (!resolved.variant.available) throw new Error(`variant ${line.variantId} is not available`);
    priced.push({
      variantId: line.variantId,
      quantity: line.quantity,
      unitPriceCents: resolved.variant.priceCents,
      currency: resolved.variant.currency.toLowerCase(),
      titleSnapshot: snapshotTitle(resolved.product, resolved.variant),
    });
  }
  const currencies = new Set(priced.map((l) => l.currency));
  if (currencies.size > 1) {
    throw new Error(`lines mix currencies: ${[...currencies].sort().join(", ")}`);
  }
  const subtotalCents = priced.reduce((s, l) => s + l.unitPriceCents * l.quantity, 0);
  const currency = currencies.values().next().value ?? "usd";
  return { lines: priced, subtotalCents, currency };
}
```

Leave `priceCart` (cart-snapshot pricing) as-is — it intentionally prices from `cart_line` snapshots, not the live catalog. `priceLines` is the live-catalog path for not-yet-carted quotes. Do **not** change `addCartLine`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/lib/order/cart.server.test.ts`
Expected: PASS (all existing cart tests still green + the new one).

- [ ] **Step 5: Commit**

```bash
git add app/lib/order/cart.server.ts app/lib/order/cart.server.test.ts
git commit -m "order/cart: extract shared priceLines() live-catalog pricing (buy-in-chat P1)"
```

---

## Task 4: `getShopOrigin()` — Shopify pull, require-setup fallback

**Files:**
- Create: `app/lib/commerce/origin.server.ts`
- Test: `app/lib/commerce/origin.server.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// app/lib/commerce/origin.server.test.ts
import { describe, it, expect, vi } from "vitest";
import { OriginNotConfiguredError } from "./origin.server";

describe("getShopOrigin", () => {
  it("throws ORIGIN_NOT_CONFIGURED when no stored origin and Shopify address is incomplete", async () => {
    vi.resetModules();
    vi.doMock("~/lib/supabase.server", () => ({
      getSupabase: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }),
    }));
    vi.doMock("./shopify-shop-address.server", () => ({ fetchShopifyShopAddress: async () => null }));
    const { getShopOrigin } = await import("./origin.server");
    await expect(getShopOrigin("shop_test")).rejects.toBeInstanceOf(OriginNotConfiguredError);
  });

  it("returns the stored origin when present (no Shopify call)", async () => {
    vi.resetModules();
    const row = { street1: "1 A St", city: "Denver", state: "CO", zip: "80202", country: "US" };
    vi.doMock("~/lib/supabase.server", () => ({
      getSupabase: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) }) }),
    }));
    const { getShopOrigin } = await import("./origin.server");
    const origin = await getShopOrigin("shop_test");
    expect(origin.zip).toBe("80202");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/lib/commerce/origin.server.test.ts`
Expected: FAIL — `origin.server.ts` does not exist.

- [ ] **Step 3: Implement**

```typescript
// app/lib/commerce/origin.server.ts
// Ship-from origin resolution: stored shop_origin -> Shopify shop.billingAddress (cached on
// first read) -> require-setup. The shipping engine cannot quote without an origin, so an
// unconfigured shop fails VISIBLY (rule 12) rather than quoting from a guessed address.
import type { Address } from "~/lib/ship-cost/adapters/rate-quote";
import { getSupabase } from "~/lib/supabase.server";
import { fetchShopifyShopAddress } from "./shopify-shop-address.server";

export class OriginNotConfiguredError extends Error {
  code = "ORIGIN_NOT_CONFIGURED";
  constructor(shopId: string) {
    super(`shop ${shopId} has no ship-from address; the merchant must set one before quoting`);
  }
}

function isComplete(a: Partial<Address> | null): a is Address {
  return !!(a && a.street1 && a.city && a.state && a.zip && a.country);
}

export async function getShopOrigin(shopId: string): Promise<Address> {
  if (!shopId) throw new Error("shopId is required");
  const sb = getSupabase();

  const stored = await sb
    .from("shop_origin")
    .select("name, street1, street2, city, state, zip, country")
    .eq("shop_id", shopId)
    .maybeSingle();
  if (stored.error) throw stored.error;
  if (isComplete(stored.data as Partial<Address> | null)) return stored.data as Address;

  // Not stored — pull from Shopify and cache it.
  const fromShopify = await fetchShopifyShopAddress(shopId);
  if (isComplete(fromShopify)) {
    await sb.from("shop_origin").upsert(
      { shop_id: shopId, ...fromShopify, source: "shopify", updated_at: new Date().toISOString() },
      { onConflict: "shop_id" },
    );
    return fromShopify;
  }

  throw new OriginNotConfiguredError(shopId);
}
```

- [ ] **Step 4: Implement the Shopify address fetch (thin)**

```typescript
// app/lib/commerce/shopify-shop-address.server.ts
// Reads the connected shop's billing address via Admin GraphQL. Returns null if unavailable
// or incomplete — the caller (getShopOrigin) decides whether that is fatal.
import type { Address } from "~/lib/ship-cost/adapters/rate-quote";

export async function fetchShopifyShopAddress(shopId: string): Promise<Address | null> {
  // Use the same authenticated Admin GraphQL client the app already uses for setVariantPrice.
  // Query: { shop { billingAddress { address1 address2 city provinceCode zip countryCodeV2 } } }
  // Map provinceCode->state, countryCodeV2->country, address1->street1, address2->street2.
  // Return null on any missing field or API error (do not throw here).
  // See app/lib/shopify/* for how an offline/admin session is obtained for a shopId.
  throw new Error("TODO is forbidden — implement using the existing Admin GraphQL client; see app/lib/price.server.ts setVariantPrice for the client pattern");
}
```

> Implement the body using the **existing** Admin GraphQL client pattern (grep `setVariantPrice` in `app/lib/.../price.server.ts` for how a shop-scoped Admin client is obtained). Map the fields as commented. The placeholder `throw` above must be replaced — it exists only to force the implementation, not to ship.

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run app/lib/commerce/origin.server.test.ts`
Expected: PASS (both tests; the Shopify fetch is mocked in the tests).

- [ ] **Step 6: Commit**

```bash
git add app/lib/commerce/origin.server.ts app/lib/commerce/shopify-shop-address.server.ts app/lib/commerce/origin.server.test.ts
git commit -m "commerce: ship-from origin (Shopify pull + require-setup) (buy-in-chat P1)"
```

---

## Task 5: `getRateSource()` — EasyPost rate adapter

**Real adapter contract (verified):** `easyPostRateAdapter.connect(shopId): Promise<RateQuoteSource | null>` — async, reads the shop's stored EasyPost credential from `integration_credentials`, decrypts it, and returns a `RateQuoteSource` (or `null` when the shop has no carrier connected). It is NOT a synchronous `.bind(apiKey)`.

**Design decision (mirrors the origin require-setup):** a shop with no connected carrier cannot get an accurate rate, so `getRateSource` fails visibly (`RATE_SOURCE_NOT_CONFIGURED`) rather than invent one. The engine's static fallback still covers transient carrier OUTAGES (a `getRates` call throwing mid-quote → `fallbackUsed=true`).

**Files:**
- Create: `app/lib/commerce/rate-source.server.ts`
- Test: `app/lib/commerce/rate-source.server.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// app/lib/commerce/rate-source.server.test.ts
import { describe, it, expect, vi } from "vitest";

describe("getRateSource", () => {
  it("returns the connected EasyPost RateQuoteSource", async () => {
    vi.resetModules();
    const src = { getRates: async () => ({ options: [], currency: "usd" }) };
    vi.doMock("~/lib/ship-cost/adapters/easypost-rate.server", () => ({ easyPostRateAdapter: { connect: async () => src } }));
    const { getRateSource } = await import("./rate-source.server");
    expect(await getRateSource("shop_test")).toBe(src);
  });
  it("throws RATE_SOURCE_NOT_CONFIGURED when the shop has no connected carrier", async () => {
    vi.resetModules();
    vi.doMock("~/lib/ship-cost/adapters/easypost-rate.server", () => ({ easyPostRateAdapter: { connect: async () => null } }));
    const { getRateSource } = await import("./rate-source.server");
    await expect(getRateSource("shop_test")).rejects.toMatchObject({ code: "RATE_SOURCE_NOT_CONFIGURED" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/lib/commerce/rate-source.server.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```typescript
// app/lib/commerce/rate-source.server.ts
// The RateQuoteSource the shipping engine calls, resolved from the shop's connected carrier
// credential (EasyPost) via the existing adapter. Mirrors the origin require-setup discipline:
// a shop with no connected carrier cannot get an accurate rate, so we fail visibly (rule 12)
// rather than invent one. The engine's static fallback still covers transient carrier OUTAGES.
import type { RateQuoteSource } from "~/lib/ship-cost/adapters/rate-quote";
import { easyPostRateAdapter } from "~/lib/ship-cost/adapters/easypost-rate.server";

export class RateSourceNotConfiguredError extends Error {
  code = "RATE_SOURCE_NOT_CONFIGURED" as const;
  constructor(shopId: string) {
    super(`shop ${shopId} has no connected shipping carrier; connect EasyPost before quoting`);
  }
}

export async function getRateSource(shopId: string): Promise<RateQuoteSource> {
  if (!shopId) throw new Error("shopId is required");
  const source = await easyPostRateAdapter.connect(shopId); // null = carrier not connected
  if (!source) throw new RateSourceNotConfiguredError(shopId);
  return source;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run app/lib/commerce/rate-source.server.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/commerce/rate-source.server.ts app/lib/commerce/rate-source.server.test.ts
git commit -m "commerce: EasyPost rate source (connect or require-setup) (buy-in-chat P1)"
```

---

## Task 6: `calculateTax()` — Stripe Tax wrapper

**Files:**
- Create: `app/lib/commerce/tax.server.ts`
- Test: `app/lib/commerce/tax.server.test.ts`

- [ ] **Step 1: Write a failing test**

```typescript
// app/lib/commerce/tax.server.test.ts
import { describe, it, expect, vi } from "vitest";

describe("calculateTax", () => {
  it("returns Stripe's computed tax in integer cents", async () => {
    vi.resetModules();
    vi.doMock("~/lib/payments/stripe.server", () => ({
      getStripe: () => ({
        tax: { calculations: { create: async () => ({ tax_amount_exclusive: 73 }) } },
      }),
    }));
    const { calculateTax } = await import("./tax.server");
    const cents = await calculateTax({
      currency: "usd",
      subtotalCents: 1000,
      shippingCents: 500,
      destination: { street1: "1 A St", city: "Denver", state: "CO", zip: "80202", country: "US" },
    });
    expect(cents).toBe(73);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/lib/commerce/tax.server.test.ts`
Expected: FAIL — `tax.server.ts` does not exist.

- [ ] **Step 3: Implement**

```typescript
// app/lib/commerce/tax.server.ts
// Stripe Tax wrapper — the single tax source for every surface. We are already on Stripe, so
// no new vendor. Returns integer cents. Throws on a Stripe error (rule 12: a wrong/zero tax in
// chat is unrecoverable, so a tax failure must fail the quote, not silently zero the tax).
import type { Address } from "~/lib/ship-cost/adapters/rate-quote";
import { getStripe } from "~/lib/payments/stripe.server";

export interface TaxInput {
  currency: string;
  subtotalCents: number;
  shippingCents: number;
  destination: Address;
}

export async function calculateTax(input: TaxInput): Promise<number> {
  const calc = await getStripe().tax.calculations.create({
    currency: input.currency,
    line_items: [{ amount: input.subtotalCents, reference: "subtotal", tax_behavior: "exclusive" }],
    shipping_cost: { amount: input.shippingCents },
    customer_details: {
      address: {
        line1: input.destination.street1,
        line2: input.destination.street2,
        city: input.destination.city,
        state: input.destination.state,
        postal_code: input.destination.zip,
        country: input.destination.country,
      },
      address_source: "shipping",
    },
  });
  return calc.tax_amount_exclusive ?? 0;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run app/lib/commerce/tax.server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/commerce/tax.server.ts app/lib/commerce/tax.server.test.ts
git commit -m "commerce: Stripe Tax wrapper (buy-in-chat P1)"
```

---

## Task 7: `quoteCart()` — the accuracy spine

**Files:**
- Create: `app/lib/commerce/quote.server.ts`
- Test: `app/lib/commerce/quote.server.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// app/lib/commerce/quote.server.test.ts
import { describe, it, expect, vi } from "vitest";

const DEST = { street1: "1 A St", city: "Denver", state: "CO", zip: "80202", country: "US" };

function mockDeps() {
  vi.doMock("~/lib/order/cart.server", () => ({
    priceLines: async () => ({
      lines: [{ variantId: "V1", quantity: 1, unitPriceCents: 1000, currency: "usd", titleSnapshot: "Widget" }],
      subtotalCents: 1000,
      currency: "usd",
    }),
  }));
  vi.doMock("./origin.server", () => ({ getShopOrigin: async () => DEST }));
  vi.doMock("./rate-source.server", () => ({ getRateSource: async () => ({ getRates: async () => ({ options: [], currency: "usd" }) }) }));
  vi.doMock("./tax.server", () => ({ calculateTax: async () => 80 }));
  vi.doMock("~/lib/shipping/engine.server", () => ({
    getShippingEngine: () => async () => ({
      options: [{ service: "ground", serviceName: "Ground", carrier: "USPS", amountCents: 500, baseAmountCents: 500, appliedRules: [], currency: "usd", deliveryWindow: { earliest: "2026-07-02", latest: "2026-07-05" }, guaranteed: false, pickupAvailable: false }],
      currency: "usd", source: "carrier", fallbackUsed: false, lowConfidence: false, requestHash: "h",
    }),
  }));
}

describe("quoteCart", () => {
  it("composes subtotal + cheapest shipping + tax into a total (cents)", async () => {
    vi.resetModules();
    mockDeps();
    const { quoteCart } = await import("./quote.server");
    const q = await quoteCart("shop_test", [{ variantId: "V1", quantity: 1 }], DEST);
    expect(q.subtotalCents).toBe(1000);
    expect(q.shippingCents).toBe(500);
    expect(q.taxCents).toBe(80);
    expect(q.totalCents).toBe(1580);
    expect(q.deliveryLatest).toBe("2026-07-05");
  });

  it("propagates fallbackUsed/lowConfidence from the engine (rule 12)", async () => {
    vi.resetModules();
    mockDeps();
    vi.doMock("~/lib/shipping/engine.server", () => ({
      getShippingEngine: () => async () => ({
        options: [{ service: "fb", serviceName: "Fallback", carrier: "flat", amountCents: 999, baseAmountCents: 999, appliedRules: [], currency: "usd", deliveryWindow: null, guaranteed: false, pickupAvailable: false }],
        currency: "usd", source: "fallback", fallbackUsed: true, lowConfidence: true, requestHash: "h",
      }),
    }));
    const { quoteCart } = await import("./quote.server");
    const q = await quoteCart("shop_test", [{ variantId: "V1", quantity: 1 }], DEST);
    expect(q.fallbackUsed).toBe(true);
    expect(q.lowConfidence).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/lib/commerce/quote.server.test.ts`
Expected: FAIL — `quote.server.ts` does not exist.

- [ ] **Step 3: Implement**

```typescript
// app/lib/commerce/quote.server.ts
// quoteCart() — THE single source of truth for an order's price. subtotal (live catalog) +
// real shipping (#6.3 engine) + Stripe Tax. Every surface (checkout, storefront widget, ACP,
// MCP) calls this; none re-computes price. Money is integer cents.
import type { ShippingQuoteRequest } from "~/lib/shipping/quote";
import { getShippingEngine } from "~/lib/shipping/engine.server";
import { priceLines } from "~/lib/order/cart.server";
import type { CartQuote, QuoteDestination, QuoteLine } from "./types";
import { getShopOrigin } from "./origin.server";
import { getRateSource } from "./rate-source.server";
import { calculateTax } from "./tax.server";

export async function quoteCart(
  shopId: string,
  lines: QuoteLine[],
  destination: QuoteDestination,
): Promise<CartQuote> {
  if (!shopId) throw new Error("shopId is required");
  if (!lines.length) throw new Error("at least one line is required to quote");

  const priced = await priceLines(shopId, lines);
  const origin = await getShopOrigin(shopId); // throws ORIGIN_NOT_CONFIGURED if unset

  const req: ShippingQuoteRequest = {
    cart: priced.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
    cartSubtotalCents: priced.subtotalCents,
    origin,
    destination,
    currency: priced.currency,
    options: { selection: "cheapest" },
  };
  const shipQuote = await getShippingEngine()(req, await getRateSource(shopId));
  const cheapest = shipQuote.options[0];
  if (!cheapest) throw new Error("shipping engine returned no options");
  const shippingCents = cheapest.amountCents;

  const taxCents = await calculateTax({
    currency: priced.currency,
    subtotalCents: priced.subtotalCents,
    shippingCents,
    destination,
  });

  return {
    lines: priced.lines,
    subtotalCents: priced.subtotalCents,
    shippingCents,
    taxCents,
    totalCents: priced.subtotalCents + shippingCents + taxCents,
    currency: priced.currency,
    deliveryEarliest: cheapest.deliveryWindow?.earliest ?? null,
    deliveryLatest: cheapest.deliveryWindow?.latest ?? null,
    lowConfidence: shipQuote.lowConfidence,
    fallbackUsed: shipQuote.fallbackUsed,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run app/lib/commerce/quote.server.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/commerce/quote.server.ts app/lib/commerce/quote.server.test.ts
git commit -m "commerce: quoteCart accuracy spine (subtotal+shipping+tax) (buy-in-chat P1)"
```

---

## Task 8: `lockQuote()` / `getQuote()` — persisted locked quotes

**Files:**
- Create: `app/lib/commerce/quote-store.server.ts`
- Test: `app/lib/commerce/quote-store.server.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// app/lib/commerce/quote-store.server.test.ts
import { describe, it, expect, vi } from "vitest";

const QUOTE = {
  lines: [{ variantId: "V1", quantity: 1, unitPriceCents: 1000, currency: "usd", titleSnapshot: "Widget" }],
  subtotalCents: 1000, shippingCents: 500, taxCents: 80, totalCents: 1580, currency: "usd",
  deliveryEarliest: null, deliveryLatest: null, lowConfidence: false, fallbackUsed: false,
};

describe("quote-store", () => {
  it("lockQuote persists a row and returns a quoteId + expiry", async () => {
    vi.resetModules();
    const inserted: Record<string, unknown>[] = [];
    vi.doMock("~/lib/supabase.server", () => ({
      getSupabase: () => ({
        from: () => ({
          insert: (row: Record<string, unknown>) => { inserted.push(row); return { select: () => ({ single: async () => ({ data: { quote_id: "q1", expires_at: row.expires_at }, error: null }) }) }; },
        }),
      }),
    }));
    const { lockQuote } = await import("./quote-store.server");
    const res = await lockQuote("shop_test", QUOTE, { clientId: "c1", destinationHash: "dh" });
    expect(res.quoteId).toBe("q1");
    expect(inserted[0].total_cents).toBe(1580);
    expect(inserted[0].shop_id).toBe("shop_test");
  });

  it("getQuote returns null for an expired row (caller must re-quote)", async () => {
    vi.resetModules();
    const past = new Date(Date.parse("2000-01-01")).toISOString();
    vi.doMock("~/lib/supabase.server", () => ({
      getSupabase: () => ({ from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { quote_id: "q1", expires_at: past, total_cents: 1580 }, error: null }) }) }) }) }) }),
    }));
    const { getQuote } = await import("./quote-store.server");
    const res = await getQuote("shop_test", "q1");
    expect(res).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/lib/commerce/quote-store.server.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```typescript
// app/lib/commerce/quote-store.server.ts
// Persist a LOCKED quote into commerce_quote_fact (append-only) and read it back. A locked
// quote never re-prices: getQuote returns the stored totals verbatim, or null once expired so
// the caller must re-quote (never silently charge a stale price). 15-minute TTL.
import { getSupabase } from "~/lib/supabase.server";
import type { CartQuote } from "./types";

const QUOTE_TTL_MS = 15 * 60 * 1000;

export interface LockedQuote extends CartQuote {
  quoteId: string;
  expiresAt: string;
}

export async function lockQuote(
  shopId: string,
  quote: CartQuote,
  meta: { clientId?: string | null; destinationHash: string; expiresInMs?: number },
): Promise<{ quoteId: string; expiresAt: string }> {
  if (!shopId) throw new Error("shopId is required");
  const expiresAt = new Date(Date.now() + (meta.expiresInMs ?? QUOTE_TTL_MS)).toISOString();
  const ins = await getSupabase()
    .from("commerce_quote_fact")
    .insert({
      shop_id: shopId,
      client_id: meta.clientId ?? null,
      line_items: quote.lines,
      subtotal_cents: quote.subtotalCents,
      shipping_cents: quote.shippingCents,
      tax_cents: quote.taxCents,
      total_cents: quote.totalCents,
      currency: quote.currency,
      destination_hash: meta.destinationHash,
      low_confidence: quote.lowConfidence,
      fallback_used: quote.fallbackUsed,
      expires_at: expiresAt,
    })
    .select("quote_id, expires_at")
    .single();
  if (ins.error) throw ins.error;
  if (!ins.data) throw new Error("commerce_quote_fact insert returned no row");
  return { quoteId: String((ins.data as Record<string, unknown>).quote_id), expiresAt };
}

export async function getQuote(shopId: string, quoteId: string): Promise<LockedQuote | null> {
  if (!shopId) throw new Error("shopId is required");
  if (!quoteId) return null;
  const row = await getSupabase()
    .from("commerce_quote_fact")
    .select("quote_id, line_items, subtotal_cents, shipping_cents, tax_cents, total_cents, currency, low_confidence, fallback_used, expires_at")
    .eq("shop_id", shopId)
    .eq("quote_id", quoteId)
    .maybeSingle();
  if (row.error) throw row.error;
  const r = row.data as Record<string, unknown> | null;
  if (!r) return null;
  if (Date.parse(String(r.expires_at)) <= Date.now()) return null; // expired -> re-quote
  return {
    quoteId: String(r.quote_id),
    lines: r.line_items as LockedQuote["lines"],
    subtotalCents: Number(r.subtotal_cents),
    shippingCents: Number(r.shipping_cents),
    taxCents: Number(r.tax_cents),
    totalCents: Number(r.total_cents),
    currency: String(r.currency),
    deliveryEarliest: null,
    deliveryLatest: null,
    lowConfidence: Boolean(r.low_confidence),
    fallbackUsed: Boolean(r.fallback_used),
    expiresAt: String(r.expires_at),
  };
}
```

> Note: `Date.now()` is fine in app code (it is forbidden only inside Workflow scripts). The expired-quote test uses a fixed past timestamp so it is deterministic.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run app/lib/commerce/quote-store.server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/commerce/quote-store.server.ts app/lib/commerce/quote-store.server.test.ts
git commit -m "commerce: locked quote persistence + expiry (buy-in-chat P1)"
```

---

## Task 9: `getAgenticCatalog()` — product feed projection

**Files:**
- Create: `app/lib/commerce/catalog.server.ts`
- Test: `app/lib/commerce/catalog.server.test.ts`

- [ ] **Step 1: Write a failing test**

```typescript
// app/lib/commerce/catalog.server.test.ts
import { describe, it, expect, vi } from "vitest";

describe("getAgenticCatalog", () => {
  it("maps v_agentic_catalog rows to feed items in cents", async () => {
    vi.resetModules();
    // v_agentic_catalog exposes a SINGLE `sku_title` (sku_dim has one `title` column, no
    // product/variant split) and `variant_id` (aliased from sku_dim.external_id).
    const rows = [{ variant_id: "V1", sku_title: "Widget - Large", retail_price_cents: 1999, currency: "usd", on_hand: 5, vendor: "Acme", category: "tools", tags: ["a"] }];
    vi.doMock("~/lib/supabase.server", () => ({
      getSupabase: () => ({ from: () => ({ select: () => ({ eq: async () => ({ data: rows, error: null }) }) }) }),
    }));
    const { getAgenticCatalog } = await import("./catalog.server");
    const feed = await getAgenticCatalog("shop_test");
    expect(feed[0]).toMatchObject({ variantId: "V1", priceCents: 1999, availableQty: 5, title: "Widget - Large" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/lib/commerce/catalog.server.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```typescript
// app/lib/commerce/catalog.server.ts
// Product-feed projection for agentic surfaces. Reads v_agentic_catalog (already excludes
// out-of-stock 'deny' SKUs at the view level) and shapes a protocol-neutral feed item the
// ACP/MCP adapters translate. Money in cents.
import { getSupabase } from "~/lib/supabase.server";

export interface CatalogFeedItem {
  variantId: string;
  title: string;
  priceCents: number;
  currency: string;
  availableQty: number;
  vendor: string | null;
  category: string | null;
  tags: string[];
}

export async function getAgenticCatalog(shopId: string): Promise<CatalogFeedItem[]> {
  if (!shopId) throw new Error("shopId is required");
  const res = await getSupabase().from("v_agentic_catalog").select("*").eq("shop_id", shopId);
  if (res.error) throw res.error;
  return ((res.data ?? []) as Record<string, unknown>[]).map((r) => {
    return {
      variantId: String(r.variant_id),
      title: String(r.sku_title), // v_agentic_catalog exposes one sku_title (no product/variant split)
      priceCents: Number(r.retail_price_cents),
      currency: String(r.currency ?? "usd").toLowerCase(),
      availableQty: Number(r.on_hand ?? 0),
      vendor: r.vendor ? String(r.vendor) : null,
      category: r.category ? String(r.category) : null,
      tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
    };
  });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run app/lib/commerce/catalog.server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/commerce/catalog.server.ts app/lib/commerce/catalog.server.test.ts
git commit -m "commerce: agentic catalog feed projection (buy-in-chat P1)"
```

---

## Task 10: Wire `quoteCart` into checkout (kill flat-0)

**Why:** `createCheckout` currently hardcodes `PILOT_FLAT_SHIPPING_CENTS = 0` and `PILOT_FLAT_TAX_CENTS = 0`. Replace those with the real quote so checkout, storefront, and chat all price identically. Checkout has a destination only when the buyer supplied a shipping address (`buyer.address`); when absent, fall back to the prior flat-0 behavior **explicitly** (a no-address checkout cannot be quoted) and mark it.

**Files:**
- Modify: `app/lib/order/checkout.server.ts:27-30,94-97`
- Test: `app/lib/order/checkout.server.test.ts` (existing)

- [ ] **Step 1: Add a failing test**

Add to `app/lib/order/checkout.server.test.ts`:

```typescript
it("uses quoteCart shipping+tax when the buyer supplies a shipping address", async () => {
  // Mock quoteCart to return non-zero shipping+tax; assert the orders insert carries them.
  // Reuse the file's existing supabase/stripe mocks; spy on the inserted order row.
  // Expected: shipping_cents = 500, tax_cents = 80, total = subtotal + 580.
});
```

> Fill the test body using the existing mock harness in this test file (it already stubs `priceCart`, `getSupabase`, and `createPaymentIntent`). Add a `vi.doMock("~/lib/commerce/quote.server", ...)` returning `{ shippingCents: 500, taxCents: 80, ... }` and assert the persisted `orders` row.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/lib/order/checkout.server.test.ts`
Expected: FAIL — checkout still writes shipping=0, tax=0.

- [ ] **Step 3: Implement the wire-in**

In `app/lib/order/checkout.server.ts`, replace the flat constants usage in `createCheckout`:

```typescript
import { quoteCart } from "~/lib/commerce/quote.server";

// ...inside createCheckout, after priceCart(...):
let shippingCents = 0;
let taxCents = 0;
if (buyer.address) {
  // A destination exists -> use the single source-of-truth quote (same engine the agentic
  // surfaces use). No address yet (rare guest path) -> 0/0 as before, made explicit here.
  const quote = await quoteCart(shopId, priced.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })), {
    street1: buyer.address.street1, street2: buyer.address.street2, city: buyer.address.city,
    state: buyer.address.state, zip: buyer.address.zip, country: buyer.address.country,
  });
  shippingCents = quote.shippingCents;
  taxCents = quote.taxCents;
}
const totalCents = priced.subtotalCents + shippingCents + taxCents;
```

Delete the now-unused `PILOT_FLAT_SHIPPING_CENTS` / `PILOT_FLAT_TAX_CENTS` constants. Confirm `BuyerAddressInput` exposes `street1/street2/city/state/zip/country` (adjust the mapping to its real field names — read `app/lib/buyer/identity.server.ts`).

- [ ] **Step 4: Run the full order suite**

Run: `npx vitest run app/lib/order/`
Expected: PASS (new test + all existing checkout/cart/emit tests still green).

- [ ] **Step 5: Commit**

```bash
git add app/lib/order/checkout.server.ts app/lib/order/checkout.server.test.ts
git commit -m "order/checkout: quote real shipping+tax via quoteCart, drop flat-0 (buy-in-chat P1)"
```

---

## Task 11: Full gate + close-out

- [ ] **Step 1: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 2: Lint (touched files, zero warnings on new code)**

Run: `npm run lint`
Expected: exit 0.

- [ ] **Step 3: Full test run**

Run: `npx vitest run`
Expected: all green.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: exit 0 (Remix+Vite build + client-bundle verifier pass).

- [ ] **Step 5: Prisma/schema validation (schema changed)**

Run: `npx prisma validate` (if `prisma/schema.prisma` mirrors these tables) and confirm the Supabase migration applies cleanly on a fresh DB.
Expected: no drift errors.

- [ ] **Step 6: Run `/code-review` on the working tree**

Resolve every blocker; downgrade nits with a one-line justification (pre-commit gate, CLAUDE.md).

---

## Self-review notes (author)

- **Spec coverage:** §5 `commerce_quote_fact`/`v_agentic_catalog` → Task 1; `quoteCart` §6 → Task 7; locked quote/expiry §5/§6 → Task 8; catalog feed §4 → Task 9; checkout flat-0 fix (§1 conflict) → Task 10; Stripe Tax §6/D7 → Task 6; ship-from origin gap (decided: Shopify-pull/require-setup) → Task 4.
- **Deferred to later plans (not P1):** `placeAgenticOrder`, the MCP/ACP adapters, spend-cap guardrail, channel marker on `orders`, storefront widget, dashboard panel. P1 deliberately stops at "accurate quote, persisted, wired into checkout."
- **Known follow-ups flagged in code:** the Admin GraphQL body in `shopify-shop-address.server.ts` (Task 4 Step 4) and the rate-adapter factory method name (Task 5) must be confirmed against the real source — both call those out explicitly.
