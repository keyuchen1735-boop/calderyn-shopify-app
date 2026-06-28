# Storefront Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a public, unauthenticated, server-rendered storefront shell that lets an anonymous buyer browse a pilot merchant's catalog (home → collection → PDP) entirely on a hard-coded fixture, behind a one-line-swappable `getCatalog()` seam.

**Architecture:** Three flat Remix routes under the `/storefront` prefix (no `authenticate.admin`) read the catalog only through the `StorefrontCatalog` contract. `getCatalog()` returns a fixture stub today; swapping in John's owned (DB-bound) impl later is a one-line return change. Every read is manually scoped by a resolved `shop_id` because there is no Postgres RLS on this public surface. Brand chrome and shop resolution are tiny hard-coded stubs.

**Tech Stack:** Remix 2.16 (Vite) + React 18 SSR, TypeScript (strict, no `any`), Vitest (node environment), plain product-neutral CSS (no Polaris). No new npm dependencies.

**Worktree:** All work happens in the **`feat/external-integrations`** worktree, created at execution time via **superpowers:using-git-worktrees** (`git worktree add ../calderyn-external-integrations -b feat/external-integrations`). Do not implement on `main` or the current workspace. This module is one of three standalone modules in that branch and has zero dependency on John's owned-catalog work.

**Conventions baked into every task:**
- **Manual `shop_id` scoping is a security requirement.** Every loader resolves `shopId` first and passes it as the **first argument** of every catalog call. The fixture is single-tenant so it cannot leak, but the pattern is the contract-level defense against cross-tenant reads on this public surface — John's owned impl MUST `.eq('shop_id', shopId)` on every query.
- **Test runner:** Vitest, node environment, `include: ["app/**/*.test.ts"]` (tests are `.test.ts`, **never** `.test.tsx` — render via `react-dom/server` + `react.createElement`, no JSX in test files).
- **Browser-source hygiene (CLAUDE.md overrides the `// ponytail:` convention here):** `// ponytail:` markers and upgrade notes go **only in `.server.ts` files** (`shop.server.ts`, `catalog.server.ts`, `catalog.stub.server.ts`) which are tree-shaken out of the client bundle. In browser-shipped files (the `storefront.*.tsx` route components and `storefront.css`), keep comments **product-neutral and technical** — no `ponytail`, no provenance, no agent/tool names. `npm run build` runs `scripts/verify-client-bundle.mjs` which fails on such markers in client output.

---

## File Structure

| File | Responsibility |
|---|---|
| `app/lib/storefront/catalog.ts` | The `StorefrontCatalog` read contract + `StoreProduct` / `StoreVariant` / `StoreCollection` DTO types (the verbatim John handoff). Types only, no runtime. |
| `app/lib/storefront/catalog.stub.server.ts` | `fixtureCatalog: StorefrontCatalog` — in-memory fixture impl over a hard-coded array (4 products / 2 collections). The default data source. Server-only. |
| `app/lib/storefront/catalog.server.ts` | `getCatalog(): StorefrontCatalog` — the single swap point. Returns `fixtureCatalog` today; one-line change to return John's owned impl later. Server-only; called only from loaders. |
| `app/lib/storefront/shop.server.ts` | `storefrontSlug(request)` (subdomain + `?shop=` dev fallback) + `resolveStorefrontShop(request): Promise<string>` + `DEMO_SHOP_ID`. Server-only. |
| `app/lib/storefront/settings.ts` | `StoreSettings` type + `getStoreSettings(shopId): StoreSettings` — hard-coded demo brand chrome (name, logo, palette). |
| `app/styles/storefront.css` | Minimal product-neutral stylesheet (the `cd-store*` / `cd-product-card*` / `cd-pdp*` class vocabulary). Linked from the layout's `links` export. Not Polaris. |
| `app/routes/storefront.tsx` | Public layout route: resolves shop, loads settings, renders brand chrome + stylesheet `links` + `<Outlet/>`. No `authenticate.admin`. |
| `app/routes/storefront._index.tsx` | Home route: `listCollections` + `listProducts` → collection nav + product grid. |
| `app/routes/storefront.collections.$handle.tsx` | Collection route: `listProducts({ collection })` → product grid; 404 when the handle yields nothing. |
| `app/routes/storefront.products.$handle.tsx` | PDP route: `getProduct` → title/description/images/variant prices + an **inert** Add-to-cart button; 404 when null. |
| `app/lib/storefront/__tests__/catalog.contract.test.ts` | Task 1 — the contract is implementable with the documented DTO shapes and `shopId`-first methods. |
| `app/lib/storefront/__tests__/catalog.stub.test.ts` | Task 2 — `fixtureCatalog` satisfies the contract (counts / filtering / null). |
| `app/lib/storefront/__tests__/catalog.server.test.ts` | Task 3 — `getCatalog()` returns the fixture data, and a second fake impl drives an identical consumer (seam proof). |
| `app/lib/storefront/__tests__/shop.server.test.ts` | Task 4 — slug derivation + `?shop=` precedence + resolution to the demo tenant. |
| `app/lib/storefront/__tests__/settings.test.ts` | Task 5 — demo brand chrome shape. |
| `app/styles/__tests__/storefront-css.test.ts` | Task 6 — stylesheet ships the base class vocabulary and is provenance-clean. |
| `app/routes/__tests__/storefront.render.test.ts` | Tasks 7–10 — the three loaders (counts + 404), the inert PDP render, and the loader-level swap (criteria 1 + 2). |
| `app/routes/__tests__/storefront.meta.test.ts` | Task 11 — every route's `meta` export yields title + description + `og:title` (criterion 3). |

**Ordering note:** the stylesheet (Task 6) is created **before** the layout route (Task 7) because the layout's `links` export imports `~/styles/storefront.css?url`; the import target must exist for that task to build green. This is a deliberate, dependency-driven swap of the spec's suggested "CSS last" order.

---

## Task 1: Define the `StorefrontCatalog` contract + DTO types

**Files:**
- Create: `app/lib/storefront/catalog.ts`
- Test: `app/lib/storefront/__tests__/catalog.contract.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/storefront/__tests__/catalog.contract.test.ts
import { describe, it, expect } from "vitest";
import type {
  StorefrontCatalog,
  StoreProduct,
  StoreVariant,
  StoreCollection,
} from "../catalog";

describe("StorefrontCatalog contract", () => {
  it("is implementable with the documented DTO shapes and shopId-first methods", async () => {
    const variant: StoreVariant = {
      id: "v1",
      sku: "SKU-1",
      title: "Default",
      priceCents: 1999,
      currency: "USD",
      available: true,
    };
    const collection: StoreCollection = { handle: "apparel", title: "Apparel" };
    const product: StoreProduct = {
      id: "p1",
      handle: "tee",
      title: "Tee",
      description: "A tee.",
      images: [{ url: "https://img.example/1.jpg", alt: "Tee" }],
      variants: [variant],
      collections: ["apparel"],
    };

    const cat: StorefrontCatalog = {
      listProducts: async (shopId, opts) => {
        expect(typeof shopId).toBe("string");
        return opts?.collection ? [product].filter((p) => p.collections.includes(opts.collection!)) : [product];
      },
      getProduct: async (_shopId, handle) => (handle === product.handle ? product : null),
      listCollections: async (_shopId) => [collection],
    };

    expect((await cat.listProducts("demo-shop")).length).toBe(1);
    expect((await cat.listProducts("demo-shop", { collection: "apparel" })).length).toBe(1);
    expect(await cat.getProduct("demo-shop", "tee")).toEqual(product);
    expect(await cat.getProduct("demo-shop", "nope")).toBeNull();
    expect((await cat.listCollections("demo-shop"))[0].handle).toBe("apparel");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run app/lib/storefront/__tests__/catalog.contract.test.ts`
  Expected: FAIL — `Cannot find module '../catalog'` (the contract file does not exist yet).

- [ ] **Step 3: Write minimal implementation**

```ts
// app/lib/storefront/catalog.ts
// The shared catalog read contract. John implements this verbatim against the
// owned catalog later (master spec §#5); the fixture stub implements it now.
// shopId is the first argument of every method — every implementation MUST scope
// its reads to that shopId (the contract-level defense against cross-tenant leakage
// on this public, unauthenticated surface; there is no Postgres RLS).
export interface StorefrontCatalog {
  listProducts(shopId: string, opts?: { collection?: string }): Promise<StoreProduct[]>;
  getProduct(shopId: string, handle: string): Promise<StoreProduct | null>;
  listCollections(shopId: string): Promise<StoreCollection[]>;
}

export interface StoreProduct {
  id: string;
  handle: string;
  title: string;
  description: string;
  images: { url: string; alt: string | null }[];
  variants: StoreVariant[];
  collections: string[]; // collection handles
}

export interface StoreVariant {
  id: string;
  sku: string | null;
  title: string;
  priceCents: number;
  currency: string;
  available: boolean;
}

export interface StoreCollection {
  handle: string;
  title: string;
}
```

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run app/lib/storefront/__tests__/catalog.contract.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git add app/lib/storefront/catalog.ts app/lib/storefront/__tests__/catalog.contract.test.ts && git commit -m "lib/storefront/catalog: StorefrontCatalog read contract + DTO types"`

---

## Task 2: Fixture stub implementation of the contract

**Files:**
- Create: `app/lib/storefront/catalog.stub.server.ts`
- Test: `app/lib/storefront/__tests__/catalog.stub.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/storefront/__tests__/catalog.stub.test.ts
import { describe, it, expect } from "vitest";
import { fixtureCatalog } from "../catalog.stub.server";

const SHOP = "demo-shop";

describe("fixtureCatalog", () => {
  it("lists all fixture products", async () => {
    expect((await fixtureCatalog.listProducts(SHOP)).length).toBe(4);
  });

  it("filters products by collection handle", async () => {
    const apparel = await fixtureCatalog.listProducts(SHOP, { collection: "apparel" });
    expect(apparel.map((p) => p.handle).sort()).toEqual(["cotton-tee", "zip-hoodie"]);
    const accessories = await fixtureCatalog.listProducts(SHOP, { collection: "accessories" });
    expect(accessories.length).toBe(2);
  });

  it("returns an empty array for an unknown collection", async () => {
    expect(await fixtureCatalog.listProducts(SHOP, { collection: "nope" })).toEqual([]);
  });

  it("gets a product by handle with its variants", async () => {
    const hoodie = await fixtureCatalog.getProduct(SHOP, "zip-hoodie");
    expect(hoodie?.title).toBe("Zip Hoodie");
    expect(hoodie?.variants.length).toBe(2);
  });

  it("returns null for an unknown product handle", async () => {
    expect(await fixtureCatalog.getProduct(SHOP, "nope")).toBeNull();
  });

  it("lists the two collections", async () => {
    expect((await fixtureCatalog.listCollections(SHOP)).map((c) => c.handle).sort()).toEqual([
      "accessories",
      "apparel",
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run app/lib/storefront/__tests__/catalog.stub.test.ts`
  Expected: FAIL — `Cannot find module '../catalog.stub.server'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/lib/storefront/catalog.stub.server.ts
// Default StorefrontCatalog implementation: a hard-coded in-memory fixture so the
// storefront shell renders with no database and no dependency on John's owned
// catalog. Swapped out behind getCatalog() once the owned impl lands.
import type {
  StorefrontCatalog,
  StoreCollection,
  StoreProduct,
} from "./catalog";

const COLLECTIONS: StoreCollection[] = [
  { handle: "apparel", title: "Apparel" },
  { handle: "accessories", title: "Accessories" },
];

// ponytail: image URLs are hotlinked — there is no owned image CDN and sku_dim has
// no image field. Acceptable for the shell; upgrade path is the catalog-image-mirror
// ETL (master spec §#7), out of scope here.
const PRODUCTS: StoreProduct[] = [
  {
    id: "p-tee",
    handle: "cotton-tee",
    title: "Cotton Tee",
    description: "Soft everyday cotton tee.",
    images: [{ url: "https://images.unsplash.com/photo-1521572163474-6864f9cf17ab", alt: "Cotton tee" }],
    variants: [
      { id: "v-tee-s", sku: "TEE-S", title: "Small", priceCents: 1999, currency: "USD", available: true },
    ],
    collections: ["apparel"],
  },
  {
    id: "p-hoodie",
    handle: "zip-hoodie",
    title: "Zip Hoodie",
    description: "Fleece-lined zip hoodie.",
    images: [{ url: "https://images.unsplash.com/photo-1556821840-3a63f95609a7", alt: "Zip hoodie" }],
    variants: [
      { id: "v-hoodie-m", sku: "HOOD-M", title: "Medium", priceCents: 5499, currency: "USD", available: true },
      { id: "v-hoodie-l", sku: "HOOD-L", title: "Large", priceCents: 5499, currency: "USD", available: false },
    ],
    collections: ["apparel"],
  },
  {
    id: "p-cap",
    handle: "canvas-cap",
    title: "Canvas Cap",
    description: "Six-panel canvas cap.",
    images: [{ url: "https://images.unsplash.com/photo-1588850561407-ed78c282e89b", alt: "Canvas cap" }],
    variants: [
      { id: "v-cap", sku: "CAP-OS", title: "One size", priceCents: 2499, currency: "USD", available: true },
    ],
    collections: ["accessories"],
  },
  {
    id: "p-tote",
    handle: "canvas-tote",
    title: "Canvas Tote",
    description: "Heavy-duty canvas tote.",
    images: [{ url: "https://images.unsplash.com/photo-1597484661643-2f5fef640dd1", alt: "Canvas tote" }],
    variants: [
      { id: "v-tote", sku: "TOTE-OS", title: "One size", priceCents: 2999, currency: "USD", available: true },
    ],
    collections: ["accessories"],
  },
];

// ponytail: single demo tenant — shopId is accepted (and required by the contract)
// but the fixture carries one tenant's data, so it cannot leak across shops. The
// owned impl MUST .eq('shop_id', shopId) on every query.
export const fixtureCatalog: StorefrontCatalog = {
  async listProducts(_shopId, opts) {
    if (!opts?.collection) return PRODUCTS;
    return PRODUCTS.filter((p) => p.collections.includes(opts.collection!));
  },
  async getProduct(_shopId, handle) {
    return PRODUCTS.find((p) => p.handle === handle) ?? null;
  },
  async listCollections(_shopId) {
    return COLLECTIONS;
  },
};
```

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run app/lib/storefront/__tests__/catalog.stub.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git add app/lib/storefront/catalog.stub.server.ts app/lib/storefront/__tests__/catalog.stub.test.ts && git commit -m "lib/storefront/catalog.stub: in-memory fixture StorefrontCatalog impl"`

---

## Task 3: `getCatalog()` factory + swap-seam proof

**Files:**
- Create: `app/lib/storefront/catalog.server.ts`
- Test: `app/lib/storefront/__tests__/catalog.server.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/storefront/__tests__/catalog.server.test.ts
import { describe, it, expect } from "vitest";
import type { StorefrontCatalog } from "../catalog";
import { getCatalog } from "../catalog.server";

const SHOP = "demo-shop";

// A consumer shaped exactly like the home loader: it only ever talks to the
// StorefrontCatalog contract, so any conforming impl must drive it identically.
async function loadHome(cat: StorefrontCatalog, shopId: string) {
  return {
    collections: await cat.listCollections(shopId),
    products: await cat.listProducts(shopId),
  };
}

describe("getCatalog", () => {
  it("returns the fixture catalog by default", async () => {
    const home = await loadHome(getCatalog(), SHOP);
    expect(home.collections.length).toBe(2);
    expect(home.products.length).toBe(4);
  });

  it("the seam holds: a second fake impl drives the same consumer unchanged", async () => {
    const secondFake: StorefrontCatalog = {
      async listCollections() {
        return [{ handle: "books", title: "Books" }];
      },
      async listProducts() {
        return [
          {
            id: "f1",
            handle: "novel",
            title: "Novel",
            description: "",
            images: [],
            variants: [{ id: "fv1", sku: null, title: "Default", priceCents: 1200, currency: "USD", available: true }],
            collections: ["books"],
          },
        ];
      },
      async getProduct(_shopId, handle) {
        return handle === "novel"
          ? {
              id: "f1",
              handle: "novel",
              title: "Novel",
              description: "",
              images: [],
              variants: [{ id: "fv1", sku: null, title: "Default", priceCents: 1200, currency: "USD", available: true }],
              collections: ["books"],
            }
          : null;
      },
    };

    const fromFixture = await loadHome(getCatalog(), SHOP);
    const fromFake = await loadHome(secondFake, SHOP);

    expect(fromFixture.products.map((p) => p.handle)).not.toContain("novel");
    expect(fromFake.collections[0].handle).toBe("books");
    expect(fromFake.products[0].handle).toBe("novel");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run app/lib/storefront/__tests__/catalog.server.test.ts`
  Expected: FAIL — `Cannot find module '../catalog.server'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/lib/storefront/catalog.server.ts
// The single swap point between the default fixture and John's eventual owned
// (DB-bound) implementation. This file is server-only (.server.ts) so the owned
// impl never reaches the client bundle. getCatalog() is invoked only from loaders.
import type { StorefrontCatalog } from "./catalog";
import { fixtureCatalog } from "./catalog.stub.server";

export function getCatalog(): StorefrontCatalog {
  // ponytail: fixture by default so the shell renders with no DB. The ENTIRE swap
  // to John's owned catalog (master spec §#5) is one line:
  //   return ownedCatalog; // once ./catalog.owned.server.ts exists
  return fixtureCatalog;
}
```

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run app/lib/storefront/__tests__/catalog.server.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git add app/lib/storefront/catalog.server.ts app/lib/storefront/__tests__/catalog.server.test.ts && git commit -m "lib/storefront/catalog.server: getCatalog() factory (one-line swap seam)"`

---

## Task 4: Shop resolver (subdomain + `?shop=` dev fallback)

**Files:**
- Create: `app/lib/storefront/shop.server.ts`
- Test: `app/lib/storefront/__tests__/shop.server.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/storefront/__tests__/shop.server.test.ts
import { describe, it, expect } from "vitest";
import { storefrontSlug, resolveStorefrontShop, DEMO_SHOP_ID } from "../shop.server";

describe("storefrontSlug", () => {
  it("derives the slug from the host subdomain", () => {
    expect(storefrontSlug(new Request("https://acme.calderyncompany.com/storefront"))).toBe("acme");
  });

  it("prefers the ?shop= dev fallback over the host, lowercased", () => {
    expect(storefrontSlug(new Request("https://other.example.com/storefront?shop=Acme"))).toBe("acme");
  });

  it("strips a port from the host", () => {
    expect(storefrontSlug(new Request("http://localhost:3000/storefront"))).toBe("localhost");
  });
});

describe("resolveStorefrontShop", () => {
  it("resolves a storefront request to the single demo tenant for the fixture pilot", async () => {
    expect(await resolveStorefrontShop(new Request("https://acme.calderyncompany.com/storefront"))).toBe(
      DEMO_SHOP_ID,
    );
    expect(await resolveStorefrontShop(new Request("http://localhost:3000/storefront?shop=demo"))).toBe(
      DEMO_SHOP_ID,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run app/lib/storefront/__tests__/shop.server.test.ts`
  Expected: FAIL — `Cannot find module '../shop.server'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/lib/storefront/shop.server.ts
// Resolves an incoming public storefront request to an internal shop_id. This is
// the unauthenticated, multi-tenant entry posture; the resolved shopId is then
// passed as the first argument of every catalog read (manual scoping).
export const DEMO_SHOP_ID = "demo-shop";

/** Derive the tenant slug: ?shop= (dev fallback) wins, else the host subdomain. */
export function storefrontSlug(request: Request): string {
  const url = new URL(request.url);
  const fromParam = url.searchParams.get("shop");
  if (fromParam) return fromParam.toLowerCase();
  const host = request.headers.get("host") ?? url.host;
  return host.split(":")[0].split(".")[0].toLowerCase();
}

export async function resolveStorefrontShop(request: Request): Promise<string> {
  const slug = storefrontSlug(request);
  // ponytail: single-tenant fixture pilot — an explicit (currently single-entry)
  // registry maps the demo slug to the one demo shop_id, and every other slug also
  // falls back to it, so the shell renders with no shops table / no DB. Upgrade:
  // replace the fallback with resolveShopId(`${slug}.myshopify.com`) once the hosting
  // module attaches real subdomains (app/lib/supabase.server.ts:37).
  const known: Record<string, string> = { demo: DEMO_SHOP_ID };
  return known[slug] ?? DEMO_SHOP_ID;
}
```

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run app/lib/storefront/__tests__/shop.server.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git add app/lib/storefront/shop.server.ts app/lib/storefront/__tests__/shop.server.test.ts && git commit -m "lib/storefront/shop.server: resolveStorefrontShop (subdomain + ?shop= fallback)"`

---

## Task 5: Store-settings stub (brand chrome)

**Files:**
- Create: `app/lib/storefront/settings.ts`
- Test: `app/lib/storefront/__tests__/settings.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/storefront/__tests__/settings.test.ts
import { describe, it, expect } from "vitest";
import { getStoreSettings } from "../settings";

describe("getStoreSettings", () => {
  it("returns demo brand chrome echoing the requested shopId", () => {
    const s = getStoreSettings("demo-shop");
    expect(s.shopId).toBe("demo-shop");
    expect(s.storeName.length).toBeGreaterThan(0);
    expect(s.logoUrl.startsWith("http")).toBe(true);
    expect(s.palette).toEqual(
      expect.objectContaining({
        primary: expect.any(String),
        background: expect.any(String),
        text: expect.any(String),
      }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run app/lib/storefront/__tests__/settings.test.ts`
  Expected: FAIL — `Cannot find module '../settings'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// app/lib/storefront/settings.ts
// Brand chrome for the storefront shell. Shadows the eventual store_settings_dim
// table (master spec §#7); hard-coded demo brand for now, no migration.
export interface StoreSettings {
  shopId: string;
  storeName: string;
  logoUrl: string; // hotlinked for now
  palette: { primary: string; background: string; text: string };
}

export function getStoreSettings(shopId: string): StoreSettings {
  return {
    shopId,
    storeName: "Calderyn Demo Store",
    logoUrl: "https://images.unsplash.com/photo-1542291026-7eec264c27ff",
    palette: { primary: "#0f766e", background: "#ffffff", text: "#111827" },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run app/lib/storefront/__tests__/settings.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git add app/lib/storefront/settings.ts app/lib/storefront/__tests__/settings.test.ts && git commit -m "lib/storefront/settings: hard-coded demo brand-chrome stub"`

---

## Task 6: Product-neutral storefront stylesheet

Created before the layout route because the layout's `links` export imports this file via `?url`.

**Files:**
- Create: `app/styles/storefront.css`
- Test: `app/styles/__tests__/storefront-css.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/styles/__tests__/storefront-css.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../storefront.css", import.meta.url)), "utf8");

describe("storefront.css", () => {
  it("ships the base class vocabulary the routes render", () => {
    for (const sel of [".cd-store", ".cd-store__grid", ".cd-product-card", ".cd-pdp__buy"]) {
      expect(css).toContain(sel);
    }
  });

  it("carries no AI/provenance markers (browser-source hygiene)", () => {
    expect(css.toLowerCase()).not.toMatch(/claude|chatgpt|copilot|vibecod|generated by|ported from|ponytail/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run app/styles/__tests__/storefront-css.test.ts`
  Expected: FAIL — `ENOENT` reading `storefront.css` (file does not exist yet).

- [ ] **Step 3: Write minimal implementation**

```css
/* app/styles/storefront.css
   Minimal, product-neutral storefront styles. Not Polaris (Polaris is embedded-admin
   only). Colors come from per-store palette applied inline by the layout. */
:root {
  --cd-gap: 16px;
  --cd-radius: 8px;
}
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }

.cd-store { max-width: 1100px; margin: 0 auto; padding: 0 var(--cd-gap); }
.cd-store__header { display: flex; align-items: center; padding: var(--cd-gap) 0; border-bottom: 1px solid #e5e7eb; }
.cd-store__logo { display: flex; align-items: center; gap: 8px; text-decoration: none; color: inherit; font-weight: 600; }
.cd-store__logo img { height: 32px; width: auto; }
.cd-store__nav { display: flex; gap: var(--cd-gap); padding: var(--cd-gap) 0; }
.cd-store__nav a { text-decoration: none; color: inherit; }
.cd-store__footer { padding: var(--cd-gap) 0; border-top: 1px solid #e5e7eb; color: #6b7280; }

.cd-store__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: var(--cd-gap); padding: var(--cd-gap) 0; }
.cd-product-card { display: flex; flex-direction: column; gap: 6px; text-decoration: none; color: inherit; border: 1px solid #e5e7eb; border-radius: var(--cd-radius); padding: 12px; }
.cd-product-card__img { width: 100%; height: 200px; object-fit: cover; border-radius: var(--cd-radius); }
.cd-product-card__title { font-weight: 600; }
.cd-product-card__price { color: #374151; }

.cd-pdp { display: grid; grid-template-columns: 1fr 1fr; gap: calc(var(--cd-gap) * 2); padding: var(--cd-gap) 0; }
.cd-pdp__gallery img { width: 100%; border-radius: var(--cd-radius); }
.cd-pdp__variants { list-style: none; padding: 0; }
.cd-pdp__buy { padding: 12px 20px; border: 0; border-radius: var(--cd-radius); background: #111827; color: #fff; font-size: 16px; cursor: pointer; }
@media (max-width: 700px) { .cd-pdp { grid-template-columns: 1fr; } }
```

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run app/styles/__tests__/storefront-css.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git add app/styles/storefront.css app/styles/__tests__/storefront-css.test.ts && git commit -m "styles/storefront: minimal product-neutral storefront stylesheet"`

---

## Task 7: Public layout route + canonical test scaffolding

**Files:**
- Create: `app/routes/storefront.tsx`
- Test: `app/routes/__tests__/storefront.render.test.ts`

This task establishes the canonical render test file (mocks for `getCatalog` and `@remix-run/react`) that Tasks 8–10 extend.

- [ ] **Step 1: Write the failing test**

```ts
// app/routes/__tests__/storefront.render.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fixtureCatalog } from "~/lib/storefront/catalog.stub.server";

// getCatalog is mocked file-wide; default returns the REAL fixture so the
// criterion-1 loader tests exercise real fixture data, while the swap test
// (Task 10) overrides it with a second fake. useLoaderData/Outlet are mocked so
// route components render in the node test environment without a router.
const { getCatalogMock, loaderDataRef } = vi.hoisted(() => ({
  getCatalogMock: vi.fn(),
  loaderDataRef: { current: null as unknown },
}));
vi.mock("~/lib/storefront/catalog.server", () => ({ getCatalog: getCatalogMock }));
vi.mock("@remix-run/react", () => ({
  useLoaderData: () => loaderDataRef.current,
  Outlet: () => null,
}));

import StorefrontLayout, { loader as layoutLoader, links } from "../storefront";

beforeEach(() => {
  getCatalogMock.mockReset();
  getCatalogMock.mockReturnValue(fixtureCatalog);
  loaderDataRef.current = null;
});

function req(url = "https://demo.calderyncompany.com/storefront") {
  return new Request(url);
}

describe("storefront layout", () => {
  it("loads demo store settings (read-only)", async () => {
    const res = await layoutLoader({ request: req(), params: {}, context: {} });
    const data = await res.json();
    expect(data.settings.storeName.length).toBeGreaterThan(0);
    expect(data.settings.palette).toHaveProperty("primary");
  });

  it("links the storefront stylesheet", () => {
    expect(JSON.stringify(links())).toContain("stylesheet");
  });

  it("renders brand chrome", () => {
    loaderDataRef.current = {
      settings: {
        shopId: "demo-shop",
        storeName: "Demo Store",
        logoUrl: "https://img.example/logo.png",
        palette: { primary: "#0f766e", background: "#ffffff", text: "#111827" },
      },
    };
    const html = renderToStaticMarkup(createElement(StorefrontLayout));
    expect(html).toContain("cd-store");
    expect(html).toContain("Demo Store");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run app/routes/__tests__/storefront.render.test.ts`
  Expected: FAIL — `Cannot find module '../storefront'`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// app/routes/storefront.tsx
// Public storefront layout. No authenticate.admin — a genuinely public, SSR route.
import type { LoaderFunctionArgs, LinksFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, Outlet } from "@remix-run/react";
import storefrontCss from "~/styles/storefront.css?url";
import { resolveStorefrontShop } from "~/lib/storefront/shop.server";
import { getStoreSettings } from "~/lib/storefront/settings";

export const links: LinksFunction = () => [{ rel: "stylesheet", href: storefrontCss }];

export async function loader({ request }: LoaderFunctionArgs) {
  // Public, multi-tenant entry: resolve the tenant from the request, then scope
  // every downstream read by this shopId (no Postgres RLS on this surface).
  const shopId = await resolveStorefrontShop(request);
  const settings = getStoreSettings(shopId);
  return json({ settings });
}

export default function StorefrontLayout() {
  const { settings } = useLoaderData<typeof loader>();
  return (
    <div
      className="cd-store"
      style={{ background: settings.palette.background, color: settings.palette.text }}
    >
      <header className="cd-store__header">
        <a className="cd-store__logo" href="/storefront">
          <img src={settings.logoUrl} alt={settings.storeName} />
          <span>{settings.storeName}</span>
        </a>
      </header>
      <main>
        <Outlet />
      </main>
      <footer className="cd-store__footer">{settings.storeName}</footer>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run app/routes/__tests__/storefront.render.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git add app/routes/storefront.tsx app/routes/__tests__/storefront.render.test.ts && git commit -m "routes/storefront: public SSR layout route + brand chrome"`

---

## Task 8: Home route (collections + product grid)

**Files:**
- Create: `app/routes/storefront._index.tsx`
- Modify: `app/routes/__tests__/storefront.render.test.ts`

- [ ] **Step 1: Write the failing test**

Add this import near the other route imports at the top of `app/routes/__tests__/storefront.render.test.ts`:

```ts
import StorefrontHome, { loader as homeLoader } from "../storefront._index";
```

Append this `describe` block to `app/routes/__tests__/storefront.render.test.ts`:

```ts
describe("storefront home", () => {
  it("loads all fixture collections and products (shopId-scoped)", async () => {
    const res = await homeLoader({ request: req(), params: {}, context: {} });
    const data = await res.json();
    expect(data.collections.length).toBe(2);
    expect(data.products.length).toBe(4);
  });

  it("renders a product grid with collection nav", () => {
    loaderDataRef.current = {
      collections: [{ handle: "apparel", title: "Apparel" }],
      products: [
        {
          id: "p1",
          handle: "cotton-tee",
          title: "Cotton Tee",
          description: "",
          images: [{ url: "https://img.example/1.jpg", alt: "Cotton tee" }],
          variants: [{ id: "v1", sku: null, title: "Default", priceCents: 1999, currency: "USD", available: true }],
          collections: ["apparel"],
        },
      ],
    };
    const html = renderToStaticMarkup(createElement(StorefrontHome));
    expect(html).toContain("cd-store__grid");
    expect(html).toContain("Cotton Tee");
    expect(html).toContain("/storefront/collections/apparel");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run app/routes/__tests__/storefront.render.test.ts`
  Expected: FAIL — `Cannot find module '../storefront._index'`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// app/routes/storefront._index.tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { resolveStorefrontShop } from "~/lib/storefront/shop.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  const catalog = getCatalog();
  // Manual shop_id scoping: shopId is the first arg of every read.
  const [collections, products] = await Promise.all([
    catalog.listCollections(shopId),
    catalog.listProducts(shopId),
  ]);
  return json({ collections, products });
}

export default function StorefrontHome() {
  const { collections, products } = useLoaderData<typeof loader>();
  return (
    <div className="cd-store__home">
      <nav className="cd-store__nav">
        {collections.map((c) => (
          <a key={c.handle} href={`/storefront/collections/${c.handle}`}>
            {c.title}
          </a>
        ))}
      </nav>
      <div className="cd-store__grid">
        {products.map((p) => (
          <a key={p.id} className="cd-product-card" href={`/storefront/products/${p.handle}`}>
            {p.images[0] ? (
              <img className="cd-product-card__img" src={p.images[0].url} alt={p.images[0].alt ?? p.title} />
            ) : null}
            <span className="cd-product-card__title">{p.title}</span>
            <span className="cd-product-card__price">
              {p.variants[0]
                ? new Intl.NumberFormat(undefined, {
                    style: "currency",
                    currency: p.variants[0].currency,
                  }).format(p.variants[0].priceCents / 100)
                : ""}
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run app/routes/__tests__/storefront.render.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git add app/routes/storefront._index.tsx app/routes/__tests__/storefront.render.test.ts && git commit -m "routes/storefront._index: home grid + collection nav loader"`

---

## Task 9: Collection route (grid + 404)

**Files:**
- Create: `app/routes/storefront.collections.$handle.tsx`
- Modify: `app/routes/__tests__/storefront.render.test.ts`

- [ ] **Step 1: Write the failing test**

Add this import near the other route imports at the top of `app/routes/__tests__/storefront.render.test.ts`:

```ts
import StorefrontCollection, { loader as collectionLoader } from "../storefront.collections.$handle";
```

Append this `describe` block to `app/routes/__tests__/storefront.render.test.ts`:

```ts
describe("storefront collection", () => {
  it("loads only that collection's products (shopId-scoped)", async () => {
    const res = await collectionLoader({ request: req(), params: { handle: "apparel" }, context: {} });
    const data = await res.json();
    expect(data.handle).toBe("apparel");
    expect(data.title).toBe("Apparel");
    expect(data.products.map((p: { handle: string }) => p.handle).sort()).toEqual([
      "cotton-tee",
      "zip-hoodie",
    ]);
  });

  it("404s when the handle yields no products", async () => {
    await expect(
      collectionLoader({ request: req(), params: { handle: "nope" }, context: {} }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("renders the collection grid", () => {
    loaderDataRef.current = {
      handle: "apparel",
      title: "Apparel",
      products: [
        {
          id: "p1",
          handle: "cotton-tee",
          title: "Cotton Tee",
          description: "",
          images: [],
          variants: [{ id: "v1", sku: null, title: "Default", priceCents: 1999, currency: "USD", available: true }],
          collections: ["apparel"],
        },
      ],
    };
    const html = renderToStaticMarkup(createElement(StorefrontCollection));
    expect(html).toContain("cd-store__grid");
    expect(html).toContain("Apparel");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run app/routes/__tests__/storefront.render.test.ts`
  Expected: FAIL — `Cannot find module '../storefront.collections.$handle'`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// app/routes/storefront.collections.$handle.tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { resolveStorefrontShop } from "~/lib/storefront/shop.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const handle = params.handle ?? "";
  const shopId = await resolveStorefrontShop(request);
  const catalog = getCatalog();
  // Manual shop_id scoping: shopId is the first arg of every read.
  const products = await catalog.listProducts(shopId, { collection: handle });
  if (products.length === 0) throw new Response(null, { status: 404 });
  const collections = await catalog.listCollections(shopId);
  const title = collections.find((c) => c.handle === handle)?.title ?? handle;
  return json({ handle, title, products });
}

export default function StorefrontCollection() {
  const { title, products } = useLoaderData<typeof loader>();
  return (
    <div className="cd-store__home">
      <h1>{title}</h1>
      <div className="cd-store__grid">
        {products.map((p) => (
          <a key={p.id} className="cd-product-card" href={`/storefront/products/${p.handle}`}>
            {p.images[0] ? (
              <img className="cd-product-card__img" src={p.images[0].url} alt={p.images[0].alt ?? p.title} />
            ) : null}
            <span className="cd-product-card__title">{p.title}</span>
            <span className="cd-product-card__price">
              {p.variants[0]
                ? new Intl.NumberFormat(undefined, {
                    style: "currency",
                    currency: p.variants[0].currency,
                  }).format(p.variants[0].priceCents / 100)
                : ""}
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run app/routes/__tests__/storefront.render.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git add app/routes/storefront.collections.\$handle.tsx app/routes/__tests__/storefront.render.test.ts && git commit -m "routes/storefront.collections.\$handle: collection grid + 404"`

---

## Task 10: PDP route (inert add-to-cart + 404) + loader-level swap proof

**Files:**
- Create: `app/routes/storefront.products.$handle.tsx`
- Modify: `app/routes/__tests__/storefront.render.test.ts`

- [ ] **Step 1: Write the failing test**

Add this import near the other route imports at the top of `app/routes/__tests__/storefront.render.test.ts`:

```ts
import StorefrontProduct, { loader as productLoader } from "../storefront.products.$handle";
import type { StorefrontCatalog } from "~/lib/storefront/catalog";
```

Append these two `describe` blocks to `app/routes/__tests__/storefront.render.test.ts`:

```ts
describe("storefront PDP", () => {
  it("loads the product with its variants (shopId-scoped)", async () => {
    const res = await productLoader({ request: req(), params: { handle: "zip-hoodie" }, context: {} });
    const data = await res.json();
    expect(data.product.title).toBe("Zip Hoodie");
    expect(data.product.variants.length).toBe(2);
    expect(data.product.variants[0].priceCents).toBe(5499);
    expect(data.product.variants[0].currency).toBe("USD");
  });

  it("404s when the product handle is unknown", async () => {
    await expect(
      productLoader({ request: req(), params: { handle: "nope" }, context: {} }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("renders an inert Add-to-cart button (no form, no submit)", () => {
    loaderDataRef.current = {
      product: {
        id: "p-hoodie",
        handle: "zip-hoodie",
        title: "Zip Hoodie",
        description: "Fleece-lined zip hoodie.",
        images: [{ url: "https://img.example/h.jpg", alt: "Zip hoodie" }],
        variants: [{ id: "v1", sku: "HOOD-M", title: "Medium", priceCents: 5499, currency: "USD", available: true }],
        collections: ["apparel"],
      },
    };
    const html = renderToStaticMarkup(createElement(StorefrontProduct));
    expect(html).toContain("Add to cart");
    expect(html).toContain('class="cd-pdp__buy"');
    expect(html).not.toContain("<form");
  });
});

describe("storefront swap seam (criterion 2)", () => {
  it("drives all three loaders through a second fake catalog unchanged", async () => {
    const novel = {
      id: "f1",
      handle: "novel",
      title: "Novel",
      description: "",
      images: [],
      variants: [{ id: "fv1", sku: null, title: "Default", priceCents: 1200, currency: "USD", available: true }],
      collections: ["books"],
    };
    const secondFake: StorefrontCatalog = {
      async listCollections() {
        return [{ handle: "books", title: "Books" }];
      },
      async listProducts(_shopId, opts) {
        return !opts?.collection || opts.collection === "books" ? [novel] : [];
      },
      async getProduct(_shopId, handle) {
        return handle === "novel" ? novel : null;
      },
    };
    getCatalogMock.mockReturnValue(secondFake);

    const home = await (await homeLoader({ request: req(), params: {}, context: {} })).json();
    expect(home.collections[0].handle).toBe("books");
    expect(home.products[0].handle).toBe("novel");

    const collection = await (
      await collectionLoader({ request: req(), params: { handle: "books" }, context: {} })
    ).json();
    expect(collection.products[0].handle).toBe("novel");

    const pdp = await (
      await productLoader({ request: req(), params: { handle: "novel" }, context: {} })
    ).json();
    expect(pdp.product.handle).toBe("novel");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run app/routes/__tests__/storefront.render.test.ts`
  Expected: FAIL — `Cannot find module '../storefront.products.$handle'`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// app/routes/storefront.products.$handle.tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { resolveStorefrontShop } from "~/lib/storefront/shop.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const handle = params.handle ?? "";
  const shopId = await resolveStorefrontShop(request);
  // Manual shop_id scoping: shopId is the first arg of the read.
  const product = await getCatalog().getProduct(shopId, handle);
  if (!product) throw new Response(null, { status: 404 });
  return json({ product });
}

export default function StorefrontProduct() {
  const { product } = useLoaderData<typeof loader>();
  return (
    <article className="cd-pdp">
      <div className="cd-pdp__gallery">
        {product.images.map((img, i) => (
          <img key={i} src={img.url} alt={img.alt ?? product.title} />
        ))}
      </div>
      <div className="cd-pdp__info">
        <h1>{product.title}</h1>
        <p>{product.description}</p>
        <ul className="cd-pdp__variants">
          {product.variants.map((v) => (
            <li key={v.id}>
              {v.title} —{" "}
              {new Intl.NumberFormat(undefined, { style: "currency", currency: v.currency }).format(
                v.priceCents / 100,
              )}
              {v.available ? "" : " (sold out)"}
            </li>
          ))}
        </ul>
        {/* Browse-only shell: Add to cart is intentionally inert (no handler, no
            form). Cart and checkout are separate modules. */}
        <button className="cd-pdp__buy" type="button">
          Add to cart
        </button>
      </div>
    </article>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run app/routes/__tests__/storefront.render.test.ts`
  Expected: PASS (all describe blocks: layout, home, collection, PDP, swap seam).

- [ ] **Step 5: Commit**
  `git add app/routes/storefront.products.\$handle.tsx app/routes/__tests__/storefront.render.test.ts && git commit -m "routes/storefront.products.\$handle: PDP with inert add-to-cart + swap-seam test"`

---

## Task 11: SEO meta + OpenGraph tags

**Files:**
- Modify: `app/routes/storefront.tsx`, `app/routes/storefront._index.tsx`, `app/routes/storefront.collections.$handle.tsx`, `app/routes/storefront.products.$handle.tsx`
- Test: `app/routes/__tests__/storefront.meta.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/routes/__tests__/storefront.meta.test.ts
import { describe, it, expect } from "vitest";
import { meta as layoutMeta } from "../storefront";
import { meta as homeMeta } from "../storefront._index";
import { meta as collectionMeta } from "../storefront.collections.$handle";
import { meta as productMeta } from "../storefront.products.$handle";

type Tag = Record<string, unknown>;

function assertSeoTags(tags: Tag[]) {
  expect(tags.some((t) => "title" in t && typeof t.title === "string" && t.title.length > 0)).toBe(true);
  expect(tags.some((t) => t.name === "description")).toBe(true);
  expect(tags.some((t) => t.property === "og:title")).toBe(true);
}

describe("storefront SEO meta", () => {
  it("layout meta has title + description + og:title", () => {
    assertSeoTags(layoutMeta({} as never) as Tag[]);
  });

  it("home meta has title + description + og:title", () => {
    assertSeoTags(homeMeta({} as never) as Tag[]);
  });

  it("collection meta uses the collection title", () => {
    const tags = collectionMeta({ data: { handle: "apparel", title: "Apparel", products: [] } } as never) as Tag[];
    assertSeoTags(tags);
    expect(JSON.stringify(tags)).toContain("Apparel");
  });

  it("product meta uses the product title", () => {
    const product = {
      id: "p1",
      handle: "zip-hoodie",
      title: "Zip Hoodie",
      description: "Fleece-lined zip hoodie.",
      images: [],
      variants: [],
      collections: ["apparel"],
    };
    const tags = productMeta({ data: { product } } as never) as Tag[];
    assertSeoTags(tags);
    expect(JSON.stringify(tags)).toContain("Zip Hoodie");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run app/routes/__tests__/storefront.meta.test.ts`
  Expected: FAIL — `layoutMeta is not a function` (no route exports a `meta` yet).

- [ ] **Step 3: Write minimal implementation**

Add to `app/routes/storefront.tsx` — extend the `@remix-run/node` type import to include `MetaFunction`, then add the `meta` export below `links`:

```tsx
import type { LoaderFunctionArgs, LinksFunction, MetaFunction } from "@remix-run/node";

export const meta: MetaFunction = () => {
  const title = "Calderyn Demo Store";
  const description = "Browse the Calderyn Demo Store.";
  return [
    { title },
    { name: "description", content: description },
    { property: "og:title", content: title },
  ];
};
```

Add to `app/routes/storefront._index.tsx` — extend the type import and add `meta`:

```tsx
import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";

export const meta: MetaFunction = () => {
  const title = "Shop all — Calderyn Demo Store";
  const description = "Browse every product in the Calderyn Demo Store.";
  return [
    { title },
    { name: "description", content: description },
    { property: "og:title", content: title },
  ];
};
```

Add to `app/routes/storefront.collections.$handle.tsx` — extend the type import and add `meta`:

```tsx
import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  const title = data ? `${data.title} — Calderyn Demo Store` : "Collection — Calderyn Demo Store";
  const description = data ? `Browse ${data.title} at the Calderyn Demo Store.` : "Browse this collection.";
  return [
    { title },
    { name: "description", content: description },
    { property: "og:title", content: title },
  ];
};
```

Add to `app/routes/storefront.products.$handle.tsx` — extend the type import and add `meta`:

```tsx
import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  const title = data ? `${data.product.title} — Calderyn Demo Store` : "Product — Calderyn Demo Store";
  const description = data?.product.description || "Product detail.";
  return [
    { title },
    { name: "description", content: description },
    { property: "og:title", content: title },
  ];
};
```

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run app/routes/__tests__/storefront.meta.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git add app/routes/storefront.tsx app/routes/storefront._index.tsx app/routes/storefront.collections.\$handle.tsx app/routes/storefront.products.\$handle.tsx app/routes/__tests__/storefront.meta.test.ts && git commit -m "routes/storefront: per-page SEO meta + OpenGraph tags"`

---

## Final verification (run before opening a PR — the repo pre-commit gate)

Run in order; paste results, do not assert success without evidence:

- [ ] `npm run test` → exit 0 (the whole suite, including all storefront tests)
- [ ] `npm run typecheck` → exit 0 (no `any`)
- [ ] `npm run lint` → exit 0 (no warnings on touched files)
- [ ] `npm run build` → exit 0 (Remix + Vite build, and `scripts/verify-client-bundle.mjs` passes — no provenance markers, no source maps in the new public route bundle)

**Success criteria mapped to tasks:**
- Three page types render against the fixture (spec criterion 1) → Tasks 7–10 loader tests.
- The seam holds under swap (criterion 2) → Task 3 (consumer-level) + Task 10 (loader-level).
- SEO tags present (criterion 3) → Task 11.
- Public, no auth (criterion 4) → Tasks 7–10 routes contain no `authenticate.admin`; loaders run without a session in tests.
- Product-neutral source (criterion 5) → Task 6 CSS test + `npm run build`'s client-bundle scan.
- No new deps; typecheck + build green (criterion 6) → final verification.
