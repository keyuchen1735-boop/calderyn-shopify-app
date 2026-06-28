# Storefront Shell — Design Spec (Calderyn Platform Pivot, module of `feat/external-integrations`)

**Date:** 2026-06-28
**Status:** Design agreed. Scope frozen to the thin browse-only shell described here — do not expand.
**Relates to:** master pivot spec `docs/superpowers/specs/2026-06-27-calderyn-platform-pivot-design.md` §#7 (storefront, lines 393–420) and §#5 (owned catalog John is building behind the contract, lines 93–117). This module is one of three standalone modules in `feat/external-integrations` and has **zero dependency** on John's owned-catalog work.

**Decisions (resolved — both were the only open points; neither is blocking):**
1. **Serving path = `/storefront/*` for the pilot.** The shell mounts under the `/storefront` route prefix so it coexists with the existing embedded-admin `_index.tsx` (which owns `/`). Production apex `/` + host→tenant routing is **deferred to the out-of-scope hosting module** — explicitly not built here.
2. **Default catalog source = hard-coded TS fixture (no DB).** The shell renders entirely on the in-memory fixture stub. The `sku_dim` real-data read stays a noted one-paragraph upgrade option (see Data model below), **not** the default.

---

## What it is

A public, unauthenticated, server-rendered (SSR) **storefront shell** that lets an anonymous buyer **browse** a pilot merchant's catalog across three page types: **home → collection → product detail (PDP)**. It is the thinnest renderer that proves the browse surface, nothing more.

It reads the catalog exclusively through a shared read interface, `StorefrontCatalog`. The default implementation is a hard-coded TypeScript fixture (a handful of products) so the shell renders with **no database and no John dependency**. When John later ships the owned-catalog implementation (master spec §#5) behind the same interface, swapping it in is a **one-line change** to the `getCatalog()` factory.

It introduces a request posture this codebase does not have today: an **unauthenticated, multi-tenant** entry point that resolves the incoming host/subdomain to an internal `shop_id` and **manually scopes every read by `shop_id`** (there is no Postgres RLS — see Risks).

**Browse-only and inert by design.** The PDP renders an Add-to-cart button, but it is **inert** (no handler, no state). There is no cart, no checkout, no payment, no shipping, no tax. Those are the other modules in this set and are explicitly out of scope here.

---

## Includes (thin)

- A new **`storefront.*` Remix route group** that does **not** call `authenticate.admin` — a genuinely public, server-rendered route set: layout + home + collection + PDP.
- A **shared catalog read contract** (`StorefrontCatalog`) and a **`getCatalog()` factory** as the single swap point between the default fixture stub and John's eventual owned implementation.
- A **fixture stub** implementing `StorefrontCatalog` from an in-memory TS array (a few products across two collections) — renders with no DB.
- A small **`store_settings` stub** (`getStoreSettings(shopId)`) supplying brand chrome: store name, logo URL, color palette.
- A **shop resolver** that derives `shop_id` from the request **subdomain**, with a `?shop=` **dev fallback**.
- **Own minimal, product-neutral CSS** (a single stylesheet) — **not** Polaris. Polaris is embedded-admin only.
- **SEO basics**: per-page `<title>`, meta description, and OpenGraph tags via each route's Remix `meta` export.
- An **inert Add-to-cart** affordance on the PDP (present, does nothing).

---

## Depends on

- **None from John.** This module ships and renders entirely on the fixture stub.
- The only seam to John's work is the **`StorefrontCatalog` interface + `getCatalog()` factory** (Data model / contracts below). John implements `StorefrontCatalog` against the owned catalog (master spec §#5); the storefront swaps it in with one line. Until then the fixture stub satisfies the contract.
- No new top-level npm dependencies. The shell is built from Remix + React + the existing `@supabase/supabase-js` client already in the repo (only used by the production shop resolver path; the fixture default needs no DB at all).

---

## Data model / contracts

### The shared catalog read contract (the John handoff — implemented verbatim)

```ts
// app/lib/storefront/catalog.ts — the contract John implements later
export interface StorefrontCatalog {
  listProducts(shopId: string, opts?: { collection?: string }): Promise<StoreProduct[]>;
  getProduct(shopId: string, handle: string): Promise<StoreProduct | null>;
  listCollections(shopId: string): Promise<StoreCollection[]>;
}
export interface StoreProduct {
  id: string; handle: string; title: string; description: string;
  images: { url: string; alt: string | null }[];
  variants: StoreVariant[]; collections: string[]; // collection handles
}
export interface StoreVariant {
  id: string; sku: string | null; title: string;
  priceCents: number; currency: string; available: boolean;
}
export interface StoreCollection { handle: string; title: string; }
```

**Security invariant baked into the contract:** `shopId` is the **first argument of every method**. Every implementation MUST scope its reads to that `shopId` (the owned impl with `.eq('shop_id', shopId)`); the fixture stub carries a single demo tenant. There is no ambient/default tenant. This is the contract-level defense against cross-tenant leakage on a public surface (see Risks).

### The single swap point — `getCatalog()` factory

```ts
// app/lib/storefront/catalog.server.ts (server-only; factory lives here so the
// eventual DB-bound owned impl stays off the client bundle)
export function getCatalog(): StorefrontCatalog;
// Default body returns the fixture impl. The ENTIRE swap to John's work is:
//   return ownedCatalog;   // (one line) once app/lib/storefront/catalog.owned.server.ts exists
```

- Interface + DTO types live in `app/lib/storefront/catalog.ts` (shared, the verbatim contract above).
- `getCatalog()` + the fixture impl live in `app/lib/storefront/catalog.server.ts` (server-only, `.server.ts` per repo convention), called only from loaders.
- Swapping stub → owned is a one-line return change in `getCatalog()`. The only constraint on the swap: John's impl is DB-bound and therefore `.server.ts`, and `getCatalog()` must only ever be invoked from a loader (it already is).

### Fixture stub (default impl)

A hard-coded TS array of ~4–6 `StoreProduct` objects spanning two `StoreCollection`s, each product carrying 1–2 variants with `priceCents`/`currency`/`available` and one or two hotlinked image URLs. The fixture impl satisfies `StorefrontCatalog` by in-memory filtering: `listProducts` filters by optional `collection` handle, `getProduct` matches `handle`, `listCollections` returns the two collections. It ignores the DB entirely so the shell renders on a cold checkout.

> **Alternative (not the default):** instead of the fixture, the stub could do a ~5-line read off the existing `sku_dim` mirror to render real pilot data: `select sku, title, retail_price_cents, currency, collections, product_id from sku_dim where shop_id = $1`, group rows by `product_id` into `StoreProduct`s, map the `collections text[]` to collection handles, and project each row to a `StoreVariant`. Images would be empty/placeholder (`sku_dim` has no image field — `ingest/types.ts:8-26`). We **default to the fixture** because it needs no DB, no real shop row, and no migration; the `sku_dim` read is offered only as a one-paragraph upgrade if real data is wanted before John lands §#5.

### `store_settings` stub (brand chrome)

```ts
// app/lib/storefront/settings.ts
export interface StoreSettings {
  shopId: string;
  storeName: string;
  logoUrl: string;            // hotlinked for now
  palette: { primary: string; background: string; text: string };
}
export function getStoreSettings(shopId: string): StoreSettings; // hardcoded demo brand
```

This stub shadows the eventual `store_settings_dim` table named in master spec §#7 (line 409). No migration in this module.

### Shop resolver

```ts
// app/lib/storefront/shop.server.ts
export function resolveStorefrontShop(request: Request): Promise<string>; // returns shop_id
```

- Production path: read the `Host` header, take the subdomain, map it to a `shop_id`.
- Dev fallback: `?shop=<value>` query param.
- `// ponytail:` default — for the fixture default, this returns a single hard-coded **demo `shop_id`** when the subdomain/param matches the demo (or when no DB is configured), so the shell renders without a `shops` row. **Named upgrade path:** route real hosts through `resolveShopId(shopDomain)` (`supabase.server.ts:37-52`) once host-based hosting (the out-of-scope module) attaches real subdomains.

### Tables / migrations

**None in this module.** The fixture + stubs replace `store_settings_dim`, `domain_dim`, and `v_storefront_product` from master spec §#7 for now. Those tables are John's / the hosting module's concern.

---

## Route map

New flat routes under `app/routes/`, mounted under a `/storefront` path prefix so they coexist with the existing embedded-admin `_index.tsx` (which owns `/`) and `/app/*`. None call `authenticate.admin`.

| Page | Route file | URL (dev) | Loader behavior |
|---|---|---|---|
| Layout / brand chrome | `storefront.tsx` | (wraps all below) | `resolveStorefrontShop(request)` → `shopId`; `getStoreSettings(shopId)` → header (logo + name) + footer + the storefront stylesheet via `links`. Renders `<Outlet/>`. Read-only. |
| Home | `storefront._index.tsx` | `/storefront` | `getCatalog().listCollections(shopId)` + `getCatalog().listProducts(shopId)` → featured grid + collection nav. Returns a typed DTO (`StoreCollection[]`, `StoreProduct[]`). |
| Collection | `storefront.collections.$handle.tsx` | `/storefront/collections/:handle` | `getCatalog().listProducts(shopId, { collection: params.handle })` → product grid for that collection. 404 (`throw new Response(null,{status:404})`) if the handle yields nothing. |
| PDP | `storefront.products.$handle.tsx` | `/storefront/products/:handle` | `getCatalog().getProduct(shopId, params.handle)` → title, description, images, variant prices/availability, **inert** Add-to-cart. 404 if `null`. |

- **Loaders are read-only**; there are no actions in this module (browse-only, the only "mutation" affordance is inert).
- Each loader independently calls `resolveStorefrontShop(request)` to get `shopId` (Remix runs child loaders in parallel with the parent, so the child cannot read the layout loader's return) and then passes `shopId` into the catalog contract — keeping the manual `shop_id` scoping explicit at every read.
- Each route exports a Remix `meta` for SEO (title/description/OpenGraph). The layout sets a sane default; leaf routes override per product/collection.
- **Production host-based serving** (subdomain → tenant, serving the shell at `/` instead of `/storefront`) is delegated to the **out-of-scope hosting module**; this module only reads the `Host` header for resolution and mounts under `/storefront` to avoid colliding with the existing `_index.tsx`.

---

## Grounding (EXISTS vs NET-NEW)

**EXISTS (read before writing):**
- `app/routes/_index.tsx:1-24` — the apex `/` is a **static marketing stub** that redirects `?shop=` → `/app`; there is **no** product/collection/cart/checkout route today. Confirms master spec §#7 line 411.
- `app/routes/app.tsx:33` — the entire `/app/*` group is gated by `authenticate.admin(request)` inside the layout loader; an unauthenticated hit is bounced. There is **no public render path**.
- `app/shopify.server.ts:96` — `authenticate` (admin + webhook) is the only auth surface exported; `authenticate.admin` is the embedded-admin gate every admin route uses.
- `app/lib/supabase.server.ts:37-52` — `resolveShopId(shopDomain)` maps a domain string → `shops.id` UUID, memoized per process; `provisionShop` (59-83) is the only creator. This is the eventual production shop resolver the dev-stub resolver upgrades into.
- `app/lib/ingest/types.ts:8-26` — `SkuRow` carries `retail_price_cents`, `currency`, `sku`, `title`, `collections: string[]` but **no image field** — basis for both the optional `sku_dim` stub read AND the image-hotlinking decision.
- Master spec §#7 (lines 393–420): the full storefront feature definition this thin shell is the first slice of. §#5 (lines 93–117): the owned catalog John builds behind `StorefrontCatalog`.
- The dashboard's `dashboard.*` routes are `dash_live_` bearer-gated (master spec line 411) — also not a public catalog surface.

**NET-NEW (this module creates):**
- `app/lib/storefront/catalog.ts` — `StorefrontCatalog` interface + DTO types (verbatim contract).
- `app/lib/storefront/catalog.server.ts` — `getCatalog()` factory + fixture impl.
- `app/lib/storefront/settings.ts` — `StoreSettings` + `getStoreSettings` stub.
- `app/lib/storefront/shop.server.ts` — `resolveStorefrontShop(request)`.
- `app/routes/storefront.tsx`, `storefront._index.tsx`, `storefront.collections.$handle.tsx`, `storefront.products.$handle.tsx`.
- `app/styles/storefront.css` — minimal product-neutral stylesheet, linked from the storefront layout's `links` export.
- One test file (Verification below).

---

## MVP rationale

This is the **buyer-facing surface a person loads to see products** — the entry point of the whole pivot. Decoupling it from John via a stub means the storefront, the owned catalog, and the commerce-write modules can be built in parallel without blocking each other. Scoping it to **browse-only with a fixture** means it renders and is reviewable on day one, with the catalog source swappable behind one line when the real data lands. Everything heavier (cart, checkout, payment, hosting, the visual builder) is deliberately excluded so this module stays a thin, swappable shell rather than a half-built store.

---

## Risks

- **Manual `shop_id` scoping on a public surface (highest).** There is no Postgres RLS. Every catalog read flows through `StorefrontCatalog` methods whose first arg is `shopId`; the fixture is single-tenant so it cannot leak, but **John's owned impl MUST `.eq('shop_id', shopId)` on every query** or a public, unauthenticated request can read another tenant's catalog/prices. The contract enforces the parameter; the impl must honor it. Call this out in the owned-impl review.
- **Image hotlinking.** Fixtures hotlink external image URLs; there is no owned image CDN and `sku_dim` has no image field (`ingest/types.ts:8-26`). Hotlinked URLs can rot or rate-limit. Acceptable for the shell; upgrade path is the catalog-image-mirror ETL / owned asset hosting from master spec §#7 line 402 — explicitly out of scope here.
- **Stub → owned swap.** The seam holds only if the owned impl returns the exact `StoreProduct`/`StoreVariant`/`StoreCollection` shapes and respects `shopId`. Mitigated by the swap-the-stub verification test below (a second fake impl proves the loaders are impl-agnostic).
- **New public origin / CSP posture.** A public route group cannot reuse the embedded-admin App Bridge/Polaris CSP. This module ships only the routes + minimal CSS; the production CSP/cache-header posture and host routing are the hosting module's job (out of scope) — flagged so it is not silently assumed done.
- **Availability semantics.** The fixture sets `available` by hand. The eventual owned impl deriving availability from `inventory_level_fact` (an append-only observation, not a ledger) can show stale "in stock" — John's concern, noted so the contract's `available: boolean` is understood as best-effort, not a reservation.

---

## Out of scope (explicit)

- Cart, checkout, order capture, payment (Stripe), shipping, tax — the other modules; the Add-to-cart button is **inert**.
- John's owned-catalog implementation (`StorefrontCatalog` against §#5) — this module ships the fixture stub only.
- Owned image CDN / catalog-image-mirror ETL — fixtures hotlink image URLs.
- Wildcard-domain / custom-domain hosting, the production CSP/cache-header posture, serving the shell at apex `/` — the hosting module.
- Postgres RLS / database-level tenant isolation.
- Buyer accounts, login, consent/cookie banners.
- The visual store builder / theme editor (master spec §#8).
- Any DB migration (`store_settings_dim`, `domain_dim`, `v_storefront_product`).
- **Dashboard parity: not applicable.** The storefront is a buyer surface, not a merchant dashboard feature, so there is **no dashboard mirror** for this module. Stated explicitly per the parity rule so it is not silently skipped.

---

## Verification & success criteria

The shell is proven when:

1. **Three page types render against the fixture.** Each of the three loaders (`storefront._index`, `storefront.collections.$handle`, `storefront.products.$handle`), invoked with the fixture stub, returns a typed DTO with the expected counts (home: ≥1 collection + ≥1 product; collection: only that collection's products; PDP: the product with its variants + `priceCents`/`currency`). A missing handle yields a 404 response.
2. **The seam holds under swap.** A second, throwaway fake `StorefrontCatalog` (different fixture data) injected via `getCatalog()` drives the same loaders unchanged and produces the new data — proving the loaders are implementation-agnostic and John's swap is genuinely one line.
3. **SEO tags present.** Each route's `meta` export yields a non-empty `<title>`, a meta description, and at least one OpenGraph tag (`og:title`).
4. **Public, no auth.** The `storefront.*` routes contain **no** `authenticate.admin` call and render without a session.
5. **Product-neutral source.** No AI/provenance/development markers in any shipped JSX/HTML comment or attribute on this public surface (repo browser-source hygiene rule); `npm run build`'s `verify-client-bundle.mjs` scan passes.
6. **No new deps; typecheck + build green.** `package.json` gains no top-level dependency; `tsc` clean (no `any`).

**One concrete runnable check:** a Vitest test `app/routes/__tests__/storefront.render.test.ts` that (a) calls each of the three loaders with the fixture stub and asserts the DTO counts + the 404 path, and (b) re-runs them with the second fake catalog impl swapped through `getCatalog()` and asserts the new data — covering criteria 1 and 2 in one command:

```
npx vitest run app/routes/__tests__/storefront.render.test.ts
```

Criteria 3–6 are covered by the existing pre-commit gate (`npm run typecheck`, `npm run lint`, `npm run build`). A manual Lighthouse/SEO pass on a locally served `/storefront` page is a nice-to-have but the `meta`-export assertion in the test is the authoritative SEO check for this module.
