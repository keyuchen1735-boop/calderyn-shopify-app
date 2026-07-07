# Search (SEO & AIO) — Plan A: engine + storefront serving

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every storefront page emit optimized, valid SEO + AIO output (meta tags, canonical, Open Graph, schema.org JSON-LD, image alt text) generated deterministically from product/store data, plus the site-wide files search engines and AI crawlers expect (`sitemap.xml`, `robots.txt`, `llms.txt`), and start logging AI-crawler visits.

**Architecture:** A new server-only `app/lib/seo/` module holds pure builders (writer -> validator -> score -> render) and site-file/crawler helpers. Storefront routes call these from their loaders and return finished Remix `meta` descriptors (including `script:ld+json`). Three new resource routes serve the public text/xml files. One small Supabase table (`seo_ai_crawl_daily`) records AI-bot hits. No merchant UI and no per-product overrides yet (those are Plan B); everything is generated live from the catalog.

**Tech Stack:** TypeScript (strict), Remix 2.17.5 (runtime; `meta()` supports `script:ld+json`), React 18, Supabase Postgres, Vitest 4.

## Global Constraints

Copied verbatim from the spec and CLAUDE.md. Every task implicitly includes these.

- Node.js 20.10+, ES modules (`"type": "module"`).
- TypeScript only. No `any` without written justification; prefer `unknown` + narrowing. `tsc --noEmit` is authoritative.
- Files ending `.server.ts` are server-only; never import them from a client module.
- Storefront is public and multi-tenant with NO Postgres RLS on that surface: every catalog/DB read is scoped by the `shopId` returned from `resolveStorefrontShop(request)`.
- Server reads Supabase via `getSupabase()` (uses `SUPABASE_SECRET_KEY`). Never reference env in client bundles.
- Browser-visible source hygiene: no comments/strings/identifiers implying AI generation, no dev overlays/debug panels, no client source maps. Keep browser-facing comments technical and product-neutral.
- No em dashes (`—`/`–`) in any user-facing copy this feature emits (titles, descriptions, alt text, `llms.txt`). Use a middot `·`, comma, or period.
- Schema changes ship as a checked-in SQL migration in `supabase/migrations/YYYYMMDDHHMMSS_snake_case.sql`, every table shop-scoped with RLS using `public.current_shop_id()`, plus `grant select ... to app_web`, plus a one-line classification in `app/lib/security/tenant-tables.ts`. Applied to prod (project `ajgrmnvzxfxxlwrxcgnu`) via the supabase MCP `apply_migration`.
- Pre-commit gate before any commit that touches routes/lib/schema: `npm run typecheck` (exit 0) -> `npm run lint` (exit 0) -> `npm run build` (exit 0). Never `--no-verify`, never silence `tsc`/eslint.
- Match existing file layout: shared logic in `app/lib/`, colocated tests in `__tests__/`.

## Shared interface contract (used across tasks)

All types live in `app/lib/seo/types.ts` (Task 1). Signatures the later tasks depend on:

```ts
// types.ts
export interface JsonLd { "@context": "https://schema.org"; "@type": string; [k: string]: unknown; }
export type OgType = "website" | "product";
export interface SeoDraft {
  title: string;            // <title> + og:title (<= 60 chars)
  description: string;      // meta description + og:description (<= 160 chars)
  canonical: string;        // absolute http(s) URL
  ogImage: string | null;   // absolute URL or null
  ogType: OgType;
  imageAlts: string[];      // one alt per product image (generated when source alt is missing)
  jsonLd: JsonLd[];         // one or more schema.org nodes
}
export type HealthStatus = "pass" | "warn" | "fail";
export interface HealthCheck { id: string; label: string; status: HealthStatus; hint?: string; }
export interface HealthReport { score: number; checks: HealthCheck[]; }
export interface SeoIssue { field: string; message: string; }
export type AiBotName =
  | "GPTBot" | "OAI-SearchBot" | "ChatGPT-User"
  | "ClaudeBot" | "anthropic-ai" | "Claude-User"
  | "PerplexityBot" | "Perplexity-User"
  | "Google-Extended" | "CCBot" | "Amazonbot" | "Bytespider" | "cohere-ai";
```

Module surface produced by this plan:

```ts
// origin.server.ts
export function storefrontOrigin(request: Request): string;
// jsonld.server.ts
export function offerNode(i: { priceCents: number; currency: string; available: boolean; sku?: string | null; url: string }): JsonLd;
export function aggregateOfferNode(i: { lowCents: number; highCents: number; currency: string; offerCount: number; anyAvailable: boolean }): JsonLd;
export function productJsonLd(i: { name: string; description: string; url: string; images: string[]; offers: JsonLd | null }): JsonLd;
export function organizationJsonLd(i: { name: string; url: string; logo?: string | null; description?: string | null }): JsonLd;
export function webSiteJsonLd(i: { name: string; url: string }): JsonLd;
export function collectionJsonLd(i: { name: string; url: string; description?: string | null }): JsonLd;
export function breadcrumbJsonLd(items: { name: string; url: string }[]): JsonLd;
// writer.server.ts
export function buildProductDraft(product: StoreProduct, store: StoreSettings, origin: string): SeoDraft;
export function buildHomeDraft(store: StoreSettings, origin: string): SeoDraft;
export function buildCollectionDraft(collection: { handle: string; title: string; description?: string | null }, store: StoreSettings, origin: string): SeoDraft;
// validator.server.ts
export function validateDraft(draft: SeoDraft): SeoIssue[];
// score.server.ts
export function scoreDraft(draft: SeoDraft): HealthReport;
// render.server.ts
export function metaFromDraft(draft: SeoDraft): MetaDescriptor[]; // MetaDescriptor from @remix-run/node
// crawlers.server.ts
export function detectAiBot(userAgent: string | null): AiBotName | null;
export function logAiCrawl(shopId: string, botName: AiBotName): Promise<void>;
// site-files.server.ts
export function buildRobotsTxt(origin: string): string;
export function buildSitemapXml(shopId: string, origin: string): Promise<string>;
export function buildLlmsTxt(shopId: string, store: StoreSettings, origin: string): Promise<string>;
```

Canonical URL shape (subdomain tenancy, storefront lives under `/storefront`):
`https://<slug>.calderyncompany.com/storefront/products/<handle>`. Origin comes from `storefrontOrigin(request)`; site files (`/sitemap.xml`, `/robots.txt`, `/llms.txt`) live at the domain root.

---

### Task 1: Types + origin helper

**Files:**
- Create: `app/lib/seo/types.ts`
- Create: `app/lib/seo/origin.server.ts`
- Test: `app/lib/seo/__tests__/origin.server.test.ts`

**Interfaces:**
- Produces: everything in the shared contract's `types.ts` block, and `storefrontOrigin(request: Request): string`.
- Consumes: nothing.

- [ ] **Step 1: Write `types.ts`** (no test — interfaces only)

Paste the entire `types.ts` block from "Shared interface contract" above into `app/lib/seo/types.ts`.

- [ ] **Step 2: Write the failing test for `storefrontOrigin`**

```ts
// app/lib/seo/__tests__/origin.server.test.ts
import { describe, it, expect } from "vitest";
import { storefrontOrigin } from "../origin.server";

function req(headers: Record<string, string>, url = "https://fallback.example/storefront"): Request {
  return new Request(url, { headers: new Headers(headers) });
}

describe("storefrontOrigin", () => {
  it("prefers x-forwarded-host + x-forwarded-proto (Vercel proxy)", () => {
    expect(storefrontOrigin(req({ "x-forwarded-host": "peakandpine.calderyncompany.com", "x-forwarded-proto": "https" })))
      .toBe("https://peakandpine.calderyncompany.com");
  });
  it("falls back to the host header as https", () => {
    expect(storefrontOrigin(req({ host: "ember.calderyncompany.com" }))).toBe("https://ember.calderyncompany.com");
  });
  it("uses http for localhost", () => {
    expect(storefrontOrigin(req({ host: "localhost:3000" }))).toBe("http://localhost:3000");
  });
  it("falls back to the request URL origin when no host header", () => {
    expect(storefrontOrigin(req({}, "https://fallback.example/storefront"))).toBe("https://fallback.example");
  });
});
```

- [ ] **Step 3: Run it, verify it fails**

Run: `npx vitest run app/lib/seo/__tests__/origin.server.test.ts`
Expected: FAIL (`Cannot find module '../origin.server'`).

- [ ] **Step 4: Implement `origin.server.ts`**

```ts
// app/lib/seo/origin.server.ts
// Absolute public origin for a storefront request. Behind Vercel's proxy the tenant
// host arrives as x-forwarded-host; locally it is the plain Host header.
export function storefrontOrigin(request: Request): string {
  const host =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    new URL(request.url).host;
  const isLocal = host.startsWith("localhost") || host.startsWith("127.0.0.1");
  const proto = request.headers.get("x-forwarded-proto") ?? (isLocal ? "http" : "https");
  return `${proto}://${host}`;
}
```

- [ ] **Step 5: Run it, verify it passes**

Run: `npx vitest run app/lib/seo/__tests__/origin.server.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add app/lib/seo/types.ts app/lib/seo/origin.server.ts app/lib/seo/__tests__/origin.server.test.ts
git commit -m "seo: add engine types and storefront origin helper"
```

---

### Task 2: schema.org JSON-LD builders

**Files:**
- Create: `app/lib/seo/jsonld.server.ts`
- Test: `app/lib/seo/__tests__/jsonld.server.test.ts`

**Interfaces:**
- Consumes: `JsonLd` from `types.ts`.
- Produces: `offerNode`, `aggregateOfferNode`, `productJsonLd`, `organizationJsonLd`, `webSiteJsonLd`, `collectionJsonLd`, `breadcrumbJsonLd` (signatures in the shared contract).

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/seo/__tests__/jsonld.server.test.ts
import { describe, it, expect } from "vitest";
import {
  offerNode, aggregateOfferNode, productJsonLd, organizationJsonLd, webSiteJsonLd, collectionJsonLd, breadcrumbJsonLd,
} from "../jsonld.server";

const URL0 = "https://ember.calderyncompany.com/storefront/products/cedar";

describe("jsonld builders", () => {
  it("offerNode formats price from cents and maps availability", () => {
    const o = offerNode({ priceCents: 3200, currency: "EUR", available: true, sku: "CB-8", url: URL0 });
    expect(o).toMatchObject({
      "@type": "Offer", price: "32.00", priceCurrency: "EUR",
      availability: "https://schema.org/InStock", sku: "CB-8", url: URL0,
    });
  });
  it("offerNode marks sold-out as OutOfStock", () => {
    expect(offerNode({ priceCents: 1000, currency: "USD", available: false, url: URL0 }).availability)
      .toBe("https://schema.org/OutOfStock");
  });
  it("aggregateOfferNode carries low/high/offerCount", () => {
    expect(aggregateOfferNode({ lowCents: 1800, highCents: 4200, currency: "EUR", offerCount: 3, anyAvailable: true }))
      .toMatchObject({ "@type": "AggregateOffer", lowPrice: "18.00", highPrice: "42.00", priceCurrency: "EUR", offerCount: 3, availability: "https://schema.org/InStock" });
  });
  it("productJsonLd nests name, image array and the offers node", () => {
    const offers = offerNode({ priceCents: 3200, currency: "EUR", available: true, url: URL0 });
    const node = productJsonLd({ name: "Cedar Bloom", description: "Soy candle.", url: URL0, images: ["https://img/1.webp"], offers });
    expect(node).toMatchObject({ "@context": "https://schema.org", "@type": "Product", name: "Cedar Bloom", image: ["https://img/1.webp"], offers });
  });
  it("productJsonLd omits offers key when not purchasable", () => {
    const node = productJsonLd({ name: "X", description: "", url: URL0, images: [], offers: null });
    expect("offers" in node).toBe(false);
  });
  it("organizationJsonLd and webSiteJsonLd carry name+url", () => {
    expect(organizationJsonLd({ name: "Ember", url: "https://ember.calderyncompany.com", logo: "https://l/x.png", description: "Candles" }))
      .toMatchObject({ "@type": "Organization", name: "Ember", logo: "https://l/x.png", description: "Candles" });
    expect(webSiteJsonLd({ name: "Ember", url: "https://ember.calderyncompany.com" }))
      .toMatchObject({ "@type": "WebSite", name: "Ember" });
  });
  it("breadcrumbJsonLd builds positioned ListItems", () => {
    const node = breadcrumbJsonLd([{ name: "Home", url: "https://x/" }, { name: "Cedar", url: URL0 }]);
    expect(node["@type"]).toBe("BreadcrumbList");
    expect((node.itemListElement as unknown[]).length).toBe(2);
    expect((node.itemListElement as Array<{ position: number }>)[1].position).toBe(2);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run app/lib/seo/__tests__/jsonld.server.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `jsonld.server.ts`**

```ts
// app/lib/seo/jsonld.server.ts
// Pure schema.org node builders. No I/O — everything is derived from its arguments so
// the shapes are validated by unit tests and safe to serialize into <script type="application/ld+json">.
import type { JsonLd } from "./types";

const CTX = "https://schema.org" as const;
const money = (cents: number) => (cents / 100).toFixed(2);
const availability = (available: boolean) =>
  available ? "https://schema.org/InStock" : "https://schema.org/OutOfStock";

export function offerNode(i: { priceCents: number; currency: string; available: boolean; sku?: string | null; url: string }): JsonLd {
  const node: JsonLd = {
    "@context": CTX, "@type": "Offer",
    price: money(i.priceCents), priceCurrency: i.currency,
    availability: availability(i.available), url: i.url,
  };
  if (i.sku) node.sku = i.sku;
  return node;
}

export function aggregateOfferNode(i: { lowCents: number; highCents: number; currency: string; offerCount: number; anyAvailable: boolean }): JsonLd {
  return {
    "@context": CTX, "@type": "AggregateOffer",
    lowPrice: money(i.lowCents), highPrice: money(i.highCents),
    priceCurrency: i.currency, offerCount: i.offerCount,
    availability: availability(i.anyAvailable),
  };
}

export function productJsonLd(i: { name: string; description: string; url: string; images: string[]; offers: JsonLd | null }): JsonLd {
  const node: JsonLd = {
    "@context": CTX, "@type": "Product",
    name: i.name, description: i.description, url: i.url, image: i.images,
  };
  if (i.offers) node.offers = i.offers;
  return node;
}

export function organizationJsonLd(i: { name: string; url: string; logo?: string | null; description?: string | null }): JsonLd {
  const node: JsonLd = { "@context": CTX, "@type": "Organization", name: i.name, url: i.url };
  if (i.logo) node.logo = i.logo;
  if (i.description) node.description = i.description;
  return node;
}

export function webSiteJsonLd(i: { name: string; url: string }): JsonLd {
  return { "@context": CTX, "@type": "WebSite", name: i.name, url: i.url };
}

export function collectionJsonLd(i: { name: string; url: string; description?: string | null }): JsonLd {
  const node: JsonLd = { "@context": CTX, "@type": "CollectionPage", name: i.name, url: i.url };
  if (i.description) node.description = i.description;
  return node;
}

export function breadcrumbJsonLd(items: { name: string; url: string }[]): JsonLd {
  return {
    "@context": CTX, "@type": "BreadcrumbList",
    itemListElement: items.map((it, idx) => ({
      "@type": "ListItem", position: idx + 1, name: it.name, item: it.url,
    })),
  };
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npx vitest run app/lib/seo/__tests__/jsonld.server.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/seo/jsonld.server.ts app/lib/seo/__tests__/jsonld.server.test.ts
git commit -m "seo: add schema.org JSON-LD node builders"
```

---

### Task 3: Draft writer (product / home / collection)

**Files:**
- Create: `app/lib/seo/text.ts` (small pure helpers: `plainText`, `clampText`, `clampTitle`)
- Create: `app/lib/seo/writer.server.ts`
- Test: `app/lib/seo/__tests__/writer.server.test.ts`

**Interfaces:**
- Consumes: `types.ts`, `jsonld.server.ts`, `StoreProduct` from `~/lib/storefront/catalog`, `StoreSettings` from `~/lib/storefront/settings.server`.
- Produces: `buildProductDraft`, `buildHomeDraft`, `buildCollectionDraft`; helpers `plainText`, `clampText`, `clampTitle`.

Reference data shapes (from the scouts):
`StoreProduct = { id, handle, title, description, images: {url, alt|null}[], variants: {id, sku|null, title, priceCents, currency, available}[], collections: string[] }`. `description` may be empty and may contain HTML. `priceCents === 0` means "not for sale" (treat as not purchasable, never emit a $0 offer).
`StoreSettings = { shopId, storeName, logoUrl|null, palette, voiceTagline|null, vibe, typeStyle, density }`. Use `voiceTagline` as the store description. There is no rating/review data, so no `AggregateRating`.

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/seo/__tests__/writer.server.test.ts
import { describe, it, expect } from "vitest";
import { buildProductDraft, buildHomeDraft, buildCollectionDraft, plainText, clampText } from "../writer.server";
import type { StoreProduct } from "~/lib/storefront/catalog";
import type { StoreSettings } from "~/lib/storefront/settings.server";

const store: StoreSettings = {
  shopId: "s1", storeName: "Ember House", logoUrl: "https://ember/logo.png",
  palette: { primary: "#111", background: "#fff", text: "#111" },
  voiceTagline: "Small-batch soy candles from Amsterdam.",
  vibe: "classic" as StoreSettings["vibe"], typeStyle: "classic" as StoreSettings["typeStyle"], density: "standard" as StoreSettings["density"],
};
const ORIGIN = "https://ember.calderyncompany.com";

function product(over: Partial<StoreProduct> = {}): StoreProduct {
  return {
    id: "p1", handle: "cedar-bloom", title: "Cedar Bloom Candle",
    description: "<p>Hand-poured <b>cedar</b> and bergamot soy candle.</p>",
    images: [{ url: "https://img/1.webp", alt: null }, { url: "https://img/2.webp", alt: "existing alt" }],
    variants: [{ id: "v1", sku: "CB-8", title: "8oz", priceCents: 3200, currency: "EUR", available: true }],
    collections: ["soy"], ...over,
  };
}

describe("text helpers", () => {
  it("plainText strips tags and collapses whitespace", () => {
    expect(plainText("<p>Hand-poured  <b>cedar</b></p>")).toBe("Hand-poured cedar");
  });
  it("clampText cuts on a word boundary within the limit", () => {
    expect(clampText("one two three four", 12)).toBe("one two");
  });
});

describe("buildProductDraft", () => {
  it("builds title, canonical, ogImage and a Product JSON-LD with a single Offer", () => {
    const d = buildProductDraft(product(), store, ORIGIN);
    expect(d.title).toBe("Cedar Bloom Candle · Ember House");
    expect(d.canonical).toBe("https://ember.calderyncompany.com/storefront/products/cedar-bloom");
    expect(d.ogImage).toBe("https://img/1.webp");
    expect(d.ogType).toBe("product");
    expect(d.description).toContain("Hand-poured cedar and bergamot");
    const prod = d.jsonLd.find((n) => n["@type"] === "Product");
    expect((prod?.offers as { "@type": string })["@type"]).toBe("Offer");
    expect(d.jsonLd.some((n) => n["@type"] === "BreadcrumbList")).toBe(true);
  });
  it("generates alt text only where the source alt is missing", () => {
    const d = buildProductDraft(product(), store, ORIGIN);
    expect(d.imageAlts[0]).toBe("Cedar Bloom Candle, Ember House");
    expect(d.imageAlts[1]).toBe("existing alt");
  });
  it("uses AggregateOffer for multiple distinct prices and skips $0 variants", () => {
    const d = buildProductDraft(product({
      variants: [
        { id: "v1", sku: null, title: "8oz", priceCents: 1800, currency: "EUR", available: true },
        { id: "v2", sku: null, title: "12oz", priceCents: 4200, currency: "EUR", available: false },
        { id: "v3", sku: null, title: "sample", priceCents: 0, currency: "EUR", available: true },
      ],
    }), store, ORIGIN);
    const prod = d.jsonLd.find((n) => n["@type"] === "Product");
    const offers = prod?.offers as { "@type": string; lowPrice: string; highPrice: string; offerCount: number };
    expect(offers["@type"]).toBe("AggregateOffer");
    expect(offers.lowPrice).toBe("18.00");
    expect(offers.highPrice).toBe("42.00");
    expect(offers.offerCount).toBe(2); // the $0 sample is excluded
  });
  it("has no offers node when nothing is purchasable", () => {
    const d = buildProductDraft(product({ variants: [{ id: "v1", sku: null, title: "x", priceCents: 0, currency: "EUR", available: true }] }), store, ORIGIN);
    const prod = d.jsonLd.find((n) => n["@type"] === "Product");
    expect("offers" in (prod ?? {})).toBe(false);
  });
});

describe("buildHomeDraft / buildCollectionDraft", () => {
  it("home draft emits Organization + WebSite and uses the tagline as description", () => {
    const d = buildHomeDraft(store, ORIGIN);
    expect(d.title).toBe("Ember House");
    expect(d.description).toBe("Small-batch soy candles from Amsterdam.");
    expect(d.canonical).toBe("https://ember.calderyncompany.com/storefront");
    expect(d.jsonLd.map((n) => n["@type"]).sort()).toEqual(["Organization", "WebSite"]);
  });
  it("collection draft canonical points at the collection path with a CollectionPage node", () => {
    const d = buildCollectionDraft({ handle: "soy", title: "Soy Candles" }, store, ORIGIN);
    expect(d.canonical).toBe("https://ember.calderyncompany.com/storefront/collections/soy");
    expect(d.title).toBe("Soy Candles · Ember House");
    expect(d.jsonLd.some((n) => n["@type"] === "CollectionPage")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run app/lib/seo/__tests__/writer.server.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `text.ts`**

```ts
// app/lib/seo/text.ts
// Deterministic text helpers shared by the writer. Pure and framework-free.
export function plainText(input: string): string {
  return input.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

export function clampText(input: string, max: number): string {
  const s = input.trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim();
}

export function clampTitle(title: string, storeName: string, max = 60): string {
  const full = `${title} · ${storeName}`;
  if (full.length <= max) return full;
  return clampText(title, max);
}
```

- [ ] **Step 4: Implement `writer.server.ts`**

```ts
// app/lib/seo/writer.server.ts
// Deterministic SEO/AIO draft writer: given owned catalog + store settings, produce a SeoDraft.
// No Claude dependency — templated output keyed to the product's own words, safe on the hot path.
import type { StoreProduct } from "~/lib/storefront/catalog";
import type { StoreSettings } from "~/lib/storefront/settings.server";
import type { JsonLd, SeoDraft } from "./types";
import { plainText, clampText, clampTitle } from "./text";
import {
  productJsonLd, offerNode, aggregateOfferNode, organizationJsonLd, webSiteJsonLd, collectionJsonLd, breadcrumbJsonLd,
} from "./jsonld.server";

export { plainText, clampText } from "./text";

const DESC_MAX = 155;

function productDescription(product: StoreProduct, store: StoreSettings): string {
  const body = plainText(product.description);
  if (body) return clampText(body, DESC_MAX);
  return clampText(`${product.title} from ${store.storeName}.`, DESC_MAX);
}

function buildOffers(product: StoreProduct, url: string): JsonLd | null {
  const sellable = product.variants.filter((v) => v.priceCents > 0);
  if (sellable.length === 0) return null;
  const currency = sellable[0].currency;
  const anyAvailable = sellable.some((v) => v.available);
  const prices = sellable.map((v) => v.priceCents);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  if (low === high) {
    const v = sellable[0];
    return offerNode({ priceCents: v.priceCents, currency, available: anyAvailable, sku: v.sku, url });
  }
  return aggregateOfferNode({ lowCents: low, highCents: high, currency, offerCount: sellable.length, anyAvailable });
}

export function buildProductDraft(product: StoreProduct, store: StoreSettings, origin: string): SeoDraft {
  const canonical = `${origin}/storefront/products/${product.handle}`;
  const description = productDescription(product, store);
  const imageAlts = product.images.map((img) => img.alt?.trim() || `${product.title}, ${store.storeName}`);
  const offers = buildOffers(product, canonical);
  const jsonLd: JsonLd[] = [
    productJsonLd({ name: product.title, description, url: canonical, images: product.images.map((i) => i.url), offers }),
    breadcrumbJsonLd([
      { name: store.storeName, url: `${origin}/storefront` },
      { name: product.title, url: canonical },
    ]),
  ];
  return {
    title: clampTitle(product.title, store.storeName),
    description,
    canonical,
    ogImage: product.images[0]?.url ?? store.logoUrl ?? null,
    ogType: "product",
    imageAlts,
    jsonLd,
  };
}

export function buildHomeDraft(store: StoreSettings, origin: string): SeoDraft {
  const canonical = `${origin}/storefront`;
  const description = clampText(store.voiceTagline?.trim() || `Browse ${store.storeName}.`, DESC_MAX);
  return {
    title: clampText(store.storeName, 60),
    description,
    canonical,
    ogImage: store.logoUrl ?? null,
    ogType: "website",
    imageAlts: [],
    jsonLd: [
      organizationJsonLd({ name: store.storeName, url: canonical, logo: store.logoUrl, description: store.voiceTagline }),
      webSiteJsonLd({ name: store.storeName, url: canonical }),
    ],
  };
}

export function buildCollectionDraft(
  collection: { handle: string; title: string; description?: string | null },
  store: StoreSettings,
  origin: string,
): SeoDraft {
  const canonical = `${origin}/storefront/collections/${collection.handle}`;
  const description = clampText(
    (collection.description && plainText(collection.description)) || `${collection.title} from ${store.storeName}.`,
    DESC_MAX,
  );
  return {
    title: clampTitle(collection.title, store.storeName),
    description,
    canonical,
    ogImage: store.logoUrl ?? null,
    ogType: "website",
    imageAlts: [],
    jsonLd: [
      collectionJsonLd({ name: collection.title, url: canonical, description }),
      breadcrumbJsonLd([
        { name: store.storeName, url: `${origin}/storefront` },
        { name: collection.title, url: canonical },
      ]),
    ],
  };
}
```

- [ ] **Step 5: Run it, verify it passes**

Run: `npx vitest run app/lib/seo/__tests__/writer.server.test.ts`
Expected: PASS (all cases). If the AggregateOffer test fails on `offerCount`, confirm `buildOffers` filters `priceCents > 0` before counting.

- [ ] **Step 6: Commit**

```bash
git add app/lib/seo/text.ts app/lib/seo/writer.server.ts app/lib/seo/__tests__/writer.server.test.ts
git commit -m "seo: add deterministic draft writer for product/home/collection"
```

---

### Task 4: Validator

**Files:**
- Create: `app/lib/seo/validator.server.ts`
- Test: `app/lib/seo/__tests__/validator.server.test.ts`

**Interfaces:**
- Consumes: `SeoDraft`, `SeoIssue`, `JsonLd` from `types.ts`.
- Produces: `validateDraft(draft: SeoDraft): SeoIssue[]` (empty array == valid).

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/seo/__tests__/validator.server.test.ts
import { describe, it, expect } from "vitest";
import { validateDraft } from "../validator.server";
import type { SeoDraft } from "../types";

function draft(over: Partial<SeoDraft> = {}): SeoDraft {
  return {
    title: "Cedar Bloom Candle · Ember House",
    description: "Hand-poured cedar and bergamot soy candle, made in small batches in Amsterdam.",
    canonical: "https://ember.calderyncompany.com/storefront/products/cedar-bloom",
    ogImage: "https://img/1.webp", ogType: "product", imageAlts: ["a"],
    jsonLd: [{ "@context": "https://schema.org", "@type": "Product", name: "Cedar Bloom", offers: { "@context": "https://schema.org", "@type": "Offer", price: "32.00", priceCurrency: "EUR", availability: "https://schema.org/InStock" } }],
    ...over,
  };
}

describe("validateDraft", () => {
  it("returns no issues for a well-formed draft", () => {
    expect(validateDraft(draft())).toEqual([]);
  });
  it("flags a too-short title", () => {
    expect(validateDraft(draft({ title: "Hi" })).some((i) => i.field === "title")).toBe(true);
  });
  it("flags a too-long description", () => {
    expect(validateDraft(draft({ description: "x".repeat(200) })).some((i) => i.field === "description")).toBe(true);
  });
  it("flags a non-absolute canonical", () => {
    expect(validateDraft(draft({ canonical: "/relative" })).some((i) => i.field === "canonical")).toBe(true);
  });
  it("flags a Product node missing required schema fields", () => {
    expect(validateDraft(draft({ jsonLd: [{ "@context": "https://schema.org", "@type": "Product" }] }))
      .some((i) => i.field === "jsonLd")).toBe(true);
  });
  it("flags a node missing @context", () => {
    expect(validateDraft(draft({ jsonLd: [{ "@type": "Product", name: "x" } as unknown as SeoDraft["jsonLd"][number]] }))
      .some((i) => i.field === "jsonLd")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run app/lib/seo/__tests__/validator.server.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `validator.server.ts`**

```ts
// app/lib/seo/validator.server.ts
// Gate: a draft that fails here must never be served or (in Plan B) published.
// Bounds follow common SERP truncation limits; JSON-LD checks assert schema.org required fields.
import type { JsonLd, SeoDraft, SeoIssue } from "./types";

const TITLE_MIN = 10, TITLE_MAX = 60, DESC_MIN = 50, DESC_MAX = 160;

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function jsonLdIssues(node: JsonLd): string[] {
  const out: string[] = [];
  if (node["@context"] !== "https://schema.org") out.push("missing @context https://schema.org");
  if (typeof node["@type"] !== "string" || !node["@type"]) out.push("missing @type");
  if (node["@type"] === "Product") {
    if (!node.name) out.push("Product.name is required");
    const offers = node.offers as Record<string, unknown> | undefined;
    if (offers) {
      const t = offers["@type"];
      if (t === "Offer" && (!offers.price || !offers.priceCurrency || !offers.availability)) {
        out.push("Offer requires price, priceCurrency, availability");
      }
      if (t === "AggregateOffer" && (!offers.lowPrice || !offers.priceCurrency)) {
        out.push("AggregateOffer requires lowPrice, priceCurrency");
      }
    }
  }
  return out;
}

export function validateDraft(draft: SeoDraft): SeoIssue[] {
  const issues: SeoIssue[] = [];
  const t = draft.title.trim().length;
  if (t < TITLE_MIN || t > TITLE_MAX) issues.push({ field: "title", message: `title must be ${TITLE_MIN}-${TITLE_MAX} chars (got ${t})` });
  const d = draft.description.trim().length;
  if (d < DESC_MIN || d > DESC_MAX) issues.push({ field: "description", message: `description must be ${DESC_MIN}-${DESC_MAX} chars (got ${d})` });
  if (!isAbsoluteHttpUrl(draft.canonical)) issues.push({ field: "canonical", message: "canonical must be an absolute http(s) URL" });
  if (draft.jsonLd.length === 0) issues.push({ field: "jsonLd", message: "at least one schema.org node is required" });
  for (const node of draft.jsonLd) {
    for (const msg of jsonLdIssues(node)) issues.push({ field: "jsonLd", message: msg });
  }
  return issues;
}
```

Note: the home draft title (e.g. "Ember House", 11 chars) passes `TITLE_MIN`. If a store name is shorter than 10 chars the validator will flag it; that is acceptable (Plan B lets the merchant override). Do not lower the bound to hide it.

- [ ] **Step 4: Run it, verify it passes**

Run: `npx vitest run app/lib/seo/__tests__/validator.server.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/seo/validator.server.ts app/lib/seo/__tests__/validator.server.test.ts
git commit -m "seo: add draft validator gating title/description/canonical/JSON-LD"
```

---

### Task 5: Health score

**Files:**
- Create: `app/lib/seo/score.server.ts`
- Test: `app/lib/seo/__tests__/score.server.test.ts`

**Interfaces:**
- Consumes: `SeoDraft`, `HealthReport`, `HealthCheck` from `types.ts`; `validateDraft` from `validator.server.ts`.
- Produces: `scoreDraft(draft: SeoDraft): HealthReport`.

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/seo/__tests__/score.server.test.ts
import { describe, it, expect } from "vitest";
import { scoreDraft } from "../score.server";
import type { SeoDraft } from "../types";

function good(): SeoDraft {
  return {
    title: "Cedar Bloom Candle · Ember House",
    description: "Hand-poured cedar and bergamot soy candle, made in small batches in Amsterdam.",
    canonical: "https://ember.calderyncompany.com/storefront/products/cedar-bloom",
    ogImage: "https://img/1.webp", ogType: "product", imageAlts: ["Cedar Bloom Candle, Ember House"],
    jsonLd: [
      { "@context": "https://schema.org", "@type": "Product", name: "Cedar Bloom", offers: { "@context": "https://schema.org", "@type": "Offer", price: "32.00", priceCurrency: "EUR", availability: "https://schema.org/InStock" } },
      { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [] },
    ],
  };
}

describe("scoreDraft", () => {
  it("scores a complete draft at 100 with all checks passing", () => {
    const r = scoreDraft(good());
    expect(r.score).toBe(100);
    expect(r.checks.every((c) => c.status === "pass")).toBe(true);
  });
  it("drops the score and fails the alt-text check when an alt is blank", () => {
    const r = scoreDraft({ ...good(), imageAlts: ["Cedar Bloom Candle, Ember House", ""] });
    expect(r.score).toBeLessThan(100);
    const alt = r.checks.find((c) => c.id === "alt");
    expect(alt?.status).toBe("fail");
    expect(alt?.hint).toBeTruthy();
  });
  it("fails the ogImage and schema checks when they are missing", () => {
    const r = scoreDraft({ ...good(), ogImage: null, jsonLd: [] });
    expect(r.checks.find((c) => c.id === "ogImage")?.status).toBe("fail");
    expect(r.checks.find((c) => c.id === "schema")?.status).toBe("fail");
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run app/lib/seo/__tests__/score.server.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `score.server.ts`**

```ts
// app/lib/seo/score.server.ts
// Rubric-based health score (0-100) shown per page in the dashboard (Plan B). Each check is
// equal-weighted; a "warn" counts as half credit. Kept deterministic for stable UI + tests.
import type { HealthCheck, HealthReport, SeoDraft } from "./types";
import { validateDraft } from "./validator.server";

export function scoreDraft(draft: SeoDraft): HealthReport {
  const issues = validateDraft(draft);
  const has = (field: string) => !issues.some((i) => i.field === field);
  const altsOk = draft.imageAlts.length === 0 || draft.imageAlts.every((a) => a.trim().length > 0);
  const hasProduct = draft.jsonLd.some((n) => n["@type"] === "Product" || n["@type"] === "CollectionPage" || n["@type"] === "Organization");
  const hasBreadcrumb = draft.jsonLd.some((n) => n["@type"] === "BreadcrumbList" || n["@type"] === "WebSite");

  const checks: HealthCheck[] = [
    { id: "title", label: "Page title", status: has("title") ? "pass" : "fail", hint: has("title") ? undefined : "Title should be 10 to 60 characters." },
    { id: "description", label: "Meta description", status: has("description") ? "pass" : "fail", hint: has("description") ? undefined : "Description should be 50 to 160 characters." },
    { id: "canonical", label: "Canonical URL", status: has("canonical") ? "pass" : "fail", hint: has("canonical") ? undefined : "Needs an absolute page URL." },
    { id: "ogImage", label: "Share image", status: draft.ogImage ? "pass" : "fail", hint: draft.ogImage ? undefined : "Add a product or logo image so links preview nicely." },
    { id: "schema", label: "Structured data", status: has("jsonLd") && hasProduct ? "pass" : "fail", hint: has("jsonLd") && hasProduct ? undefined : "Structured data is missing or invalid." },
    { id: "breadcrumb", label: "Breadcrumbs / site links", status: hasBreadcrumb ? "pass" : "warn", hint: hasBreadcrumb ? undefined : "Breadcrumb links help search engines understand structure." },
    { id: "alt", label: "Image alt text", status: altsOk ? "pass" : "fail", hint: altsOk ? undefined : "Every image needs descriptive alt text." },
  ];

  const credit = checks.reduce((sum, c) => sum + (c.status === "pass" ? 1 : c.status === "warn" ? 0.5 : 0), 0);
  const score = Math.round((credit / checks.length) * 100);
  return { score, checks };
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npx vitest run app/lib/seo/__tests__/score.server.test.ts`
Expected: PASS (3 tests). The "all pass" case: `good()` has ogImage, valid schema with a Product, and a BreadcrumbList, so every check is `pass` -> 100.

- [ ] **Step 5: Commit**

```bash
git add app/lib/seo/score.server.ts app/lib/seo/__tests__/score.server.test.ts
git commit -m "seo: add health score rubric over a draft"
```

---

### Task 6: Render draft to Remix meta descriptors

**Files:**
- Create: `app/lib/seo/render.server.ts`
- Test: `app/lib/seo/__tests__/render.server.test.ts`

**Interfaces:**
- Consumes: `SeoDraft`, `JsonLd` from `types.ts`; `MetaDescriptor` from `@remix-run/node`.
- Produces: `metaFromDraft(draft: SeoDraft): MetaDescriptor[]`.

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/seo/__tests__/render.server.test.ts
import { describe, it, expect } from "vitest";
import { metaFromDraft } from "../render.server";
import type { SeoDraft } from "../types";

function draft(over: Partial<SeoDraft> = {}): SeoDraft {
  return {
    title: "Cedar Bloom Candle · Ember House",
    description: "Hand-poured cedar and bergamot soy candle.",
    canonical: "https://ember.calderyncompany.com/storefront/products/cedar-bloom",
    ogImage: "https://img/1.webp", ogType: "product", imageAlts: [],
    jsonLd: [{ "@context": "https://schema.org", "@type": "Product", name: "Cedar Bloom" }],
    ...over,
  };
}

describe("metaFromDraft", () => {
  it("emits title, description, canonical link, OG/Twitter tags and one ld+json per node", () => {
    const m = metaFromDraft(draft());
    expect(m).toContainEqual({ title: "Cedar Bloom Candle · Ember House" });
    expect(m).toContainEqual({ name: "description", content: "Hand-poured cedar and bergamot soy candle." });
    expect(m).toContainEqual({ tagName: "link", rel: "canonical", href: "https://ember.calderyncompany.com/storefront/products/cedar-bloom" });
    expect(m).toContainEqual({ property: "og:type", content: "product" });
    expect(m).toContainEqual({ property: "og:image", content: "https://img/1.webp" });
    expect(m).toContainEqual({ name: "twitter:card", content: "summary_large_image" });
    expect(m.filter((d) => "script:ld+json" in (d as object))).toHaveLength(1);
  });
  it("omits og:image and uses summary card when there is no image", () => {
    const m = metaFromDraft(draft({ ogImage: null }));
    expect(m.some((d) => (d as { property?: string }).property === "og:image")).toBe(false);
    expect(m).toContainEqual({ name: "twitter:card", content: "summary" });
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run app/lib/seo/__tests__/render.server.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `render.server.ts`**

```ts
// app/lib/seo/render.server.ts
// Turn a validated SeoDraft into Remix meta descriptors. Remix 2.17 serializes the special
// "script:ld+json" descriptor into a <script type="application/ld+json"> tag in <head>.
import type { MetaDescriptor } from "@remix-run/node";
import type { SeoDraft } from "./types";

export function metaFromDraft(draft: SeoDraft): MetaDescriptor[] {
  const out: MetaDescriptor[] = [
    { title: draft.title },
    { name: "description", content: draft.description },
    { tagName: "link", rel: "canonical", href: draft.canonical },
    { property: "og:title", content: draft.title },
    { property: "og:description", content: draft.description },
    { property: "og:type", content: draft.ogType },
    { property: "og:url", content: draft.canonical },
  ];
  if (draft.ogImage) out.push({ property: "og:image", content: draft.ogImage });
  out.push({ name: "twitter:card", content: draft.ogImage ? "summary_large_image" : "summary" });
  for (const node of draft.jsonLd) out.push({ "script:ld+json": node });
  return out;
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npx vitest run app/lib/seo/__tests__/render.server.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/seo/render.server.ts app/lib/seo/__tests__/render.server.test.ts
git commit -m "seo: render a draft to Remix meta descriptors incl JSON-LD"
```

---

### Task 7: AI-crawler detection + logging (migration + table)

**Files:**
- Create: `supabase/migrations/20260706193000_seo_ai_crawl.sql`
- Modify: `app/lib/security/tenant-tables.ts` (add `seo_ai_crawl_daily` to `SHOP_SCOPE_POLICY_TABLES`)
- Create: `app/lib/seo/crawlers.server.ts`
- Test: `app/lib/seo/__tests__/crawlers.server.test.ts`

**Interfaces:**
- Consumes: `AiBotName` from `types.ts`; `getSupabase` from `~/lib/supabase.server`.
- Produces: `detectAiBot(userAgent: string | null): AiBotName | null` (pure), `logAiCrawl(shopId: string, botName: AiBotName): Promise<void>` (DB, failure-isolated, skips non-UUID shops).

- [ ] **Step 1: Write the migration SQL**

Create `supabase/migrations/20260706193000_seo_ai_crawl.sql`:

```sql
-- Records AI-assistant crawler visits per store/day. The AIO analogue of Search Console:
-- there is no "AI console", so we count when known answer-engine bots read a tenant's pages.
create table public.seo_ai_crawl_daily (
  shop_id  uuid    not null references public.shops(id) on delete cascade,
  bot_name text    not null,
  day      date    not null default current_date,
  hits     integer not null default 0,
  primary key (shop_id, bot_name, day)
);
create index seo_ai_crawl_daily_shop_idx on public.seo_ai_crawl_daily (shop_id);

alter table public.seo_ai_crawl_daily enable row level security;
create policy seo_ai_crawl_daily_shop_scope on public.seo_ai_crawl_daily
  for all
  using (shop_id = public.current_shop_id())
  with check (shop_id = public.current_shop_id());
revoke all on table public.seo_ai_crawl_daily from anon, authenticated;
grant select on table public.seo_ai_crawl_daily to app_web;

-- Atomic per-day increment. Server calls this with the service key (bypasses RLS); the
-- anon/authenticated lanes must not be able to inflate a competitor's counters.
create or replace function public.log_ai_crawl(p_shop_id uuid, p_bot text)
returns void
language sql
as $$
  insert into public.seo_ai_crawl_daily (shop_id, bot_name, day, hits)
  values (p_shop_id, p_bot, current_date, 1)
  on conflict (shop_id, bot_name, day)
  do update set hits = public.seo_ai_crawl_daily.hits + 1;
$$;
revoke execute on function public.log_ai_crawl(uuid, text) from anon, authenticated;

-- Self-test: RLS must be enabled, or fail the apply (mirrors the tenant_isolation_hardening pattern).
do $$
begin
  if not exists (
    select 1 from pg_tables where schemaname = 'public' and tablename = 'seo_ai_crawl_daily' and rowsecurity = true
  ) then
    raise exception 'seo_ai_crawl_daily is missing RLS';
  end if;
end $$;
```

- [ ] **Step 2: Classify the table (or `verify-rls` warns)**

In `app/lib/security/tenant-tables.ts`, add `"seo_ai_crawl_daily"` to the `SHOP_SCOPE_POLICY_TABLES` array (keep alphabetical if the file is sorted). This is the direct-`shop_id` bucket. Do NOT add it to `FK_CHILD_POLICY_TABLES` or `DENY_ALL_TABLES`.

- [ ] **Step 3: Write the failing test** (pure detection + logging behavior with a mocked Supabase, mirroring `events.server.test.ts`)

```ts
// app/lib/seo/__tests__/crawlers.server.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const rpcCalls: Array<{ fn: string; args: unknown }> = [];
let rpcError: { message: string } | null = null;

vi.mock("../../supabase.server", () => ({
  getSupabase: () => ({
    rpc: async (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      return { error: rpcError };
    },
  }),
}));

// eslint-disable-next-line import/first -- imports must follow vi.mock
import { detectAiBot, logAiCrawl } from "../crawlers.server";

const SHOP = "11111111-2222-3333-4444-555555555555";

beforeEach(() => { rpcCalls.length = 0; rpcError = null; });

describe("detectAiBot", () => {
  it.each([
    ["Mozilla/5.0 (compatible; GPTBot/1.1; +https://openai.com/gptbot)", "GPTBot"],
    ["Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)", "ClaudeBot"],
    ["Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/bot)", "PerplexityBot"],
    ["Mozilla/5.0 (compatible; Google-Extended)", "Google-Extended"],
    ["CCBot/2.0 (https://commoncrawl.org/faq/)", "CCBot"],
  ])("classifies %s", (ua, expected) => {
    expect(detectAiBot(ua)).toBe(expected);
  });
  it("returns null for a normal browser and for Googlebot (search, not AI)", () => {
    expect(detectAiBot("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBeNull();
    expect(detectAiBot("Googlebot/2.1 (+http://www.google.com/bot.html)")).toBeNull();
    expect(detectAiBot(null)).toBeNull();
  });
});

describe("logAiCrawl", () => {
  it("calls the log_ai_crawl RPC for a real (UUID) shop", async () => {
    await logAiCrawl(SHOP, "GPTBot");
    expect(rpcCalls).toEqual([{ fn: "log_ai_crawl", args: { p_shop_id: SHOP, p_bot: "GPTBot" } }]);
  });
  it("skips non-UUID (demo) shops", async () => {
    await logAiCrawl("demo-shop", "GPTBot");
    expect(rpcCalls).toHaveLength(0);
  });
  it("swallows RPC errors (logs, never throws)", async () => {
    rpcError = { message: "boom" };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(logAiCrawl(SHOP, "GPTBot")).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
```

- [ ] **Step 4: Run it, verify it fails**

Run: `npx vitest run app/lib/seo/__tests__/crawlers.server.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 5: Implement `crawlers.server.ts`**

```ts
// app/lib/seo/crawlers.server.ts
// Known answer-engine / AI crawler user-agents. Distinct from generic search bots (Googlebot,
// Bingbot) — those are SEO, these are AIO. Order matters: match the most specific token first.
import type { AiBotName } from "./types";
import { getSupabase } from "~/lib/supabase.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// [token as it appears in the UA (lowercased), canonical bot name]
const AI_BOTS: Array<[string, AiBotName]> = [
  ["oai-searchbot", "OAI-SearchBot"],
  ["chatgpt-user", "ChatGPT-User"],
  ["gptbot", "GPTBot"],
  ["claudebot", "ClaudeBot"],
  ["claude-user", "Claude-User"],
  ["anthropic-ai", "anthropic-ai"],
  ["perplexitybot", "PerplexityBot"],
  ["perplexity-user", "Perplexity-User"],
  ["google-extended", "Google-Extended"],
  ["ccbot", "CCBot"],
  ["amazonbot", "Amazonbot"],
  ["bytespider", "Bytespider"],
  ["cohere-ai", "cohere-ai"],
];

export function detectAiBot(userAgent: string | null): AiBotName | null {
  if (!userAgent) return null;
  const ua = userAgent.toLowerCase();
  for (const [token, name] of AI_BOTS) {
    if (ua.includes(token)) return name;
  }
  return null;
}

// Fire-and-forget from storefront loaders. Never throws; skips the demo shell (non-UUID shop id).
export async function logAiCrawl(shopId: string, botName: AiBotName): Promise<void> {
  if (!UUID_RE.test(shopId)) return;
  try {
    const { error } = await getSupabase().rpc("log_ai_crawl", { p_shop_id: shopId, p_bot: botName });
    if (error) console.error(`[seo] logAiCrawl failed for shop ${shopId}:`, error.message);
  } catch (err) {
    console.error(`[seo] logAiCrawl threw for shop ${shopId}:`, err);
  }
}
```

- [ ] **Step 6: Run it, verify it passes**

Run: `npx vitest run app/lib/seo/__tests__/crawlers.server.test.ts`
Expected: PASS (detection cases + 3 logging cases).

- [ ] **Step 7: Commit** (code + migration; the migration is APPLIED in Task 12, not here)

```bash
git add supabase/migrations/20260706193000_seo_ai_crawl.sql app/lib/security/tenant-tables.ts app/lib/seo/crawlers.server.ts app/lib/seo/__tests__/crawlers.server.test.ts
git commit -m "seo: add AI-crawler detection + seo_ai_crawl_daily table and logger"
```

---

### Task 8: Site files (robots.txt, sitemap.xml, llms.txt builders)

**Files:**
- Create: `app/lib/seo/site-files.server.ts`
- Test: `app/lib/seo/__tests__/site-files.server.test.ts`

**Interfaces:**
- Consumes: `getCatalog` from `~/lib/storefront/catalog.server`; `StoreSettings` from `~/lib/storefront/settings.server`; `AiBotName` list is not needed here.
- Produces: `buildRobotsTxt(origin)` (pure), `buildSitemapXml(shopId, origin)` (async), `buildLlmsTxt(shopId, store, origin)` (async).

Note the PostgREST 1000-row clamp: `listProducts` returns at most 1000 rows regardless. That is acceptable for v1; a future task can paginate the sitemap.

- [ ] **Step 1: Write the failing test** (mock the catalog module)

```ts
// app/lib/seo/__tests__/site-files.server.test.ts
import { describe, it, expect, vi } from "vitest";

vi.mock("../../storefront/catalog.server", () => ({
  getCatalog: () => ({
    listProducts: async () => [
      { id: "p1", handle: "cedar-bloom", title: "Cedar Bloom", description: "Soy candle", images: [], variants: [{ id: "v1", sku: null, title: "8oz", priceCents: 3200, currency: "EUR", available: true }], collections: [] },
      { id: "p2", handle: "vanilla", title: "Vanilla 8oz", description: "", images: [], variants: [{ id: "v2", sku: null, title: "8oz", priceCents: 2500, currency: "EUR", available: false }], collections: [] },
    ],
    listCollections: async () => [{ handle: "soy", title: "Soy Candles" }],
    getProduct: async () => null,
  }),
}));

// eslint-disable-next-line import/first
import { buildRobotsTxt, buildSitemapXml, buildLlmsTxt } from "../site-files.server";
import type { StoreSettings } from "~/lib/storefront/settings.server";

const ORIGIN = "https://ember.calderyncompany.com";
const store: StoreSettings = {
  shopId: "s1", storeName: "Ember House", logoUrl: null,
  palette: { primary: "#111", background: "#fff", text: "#111" },
  voiceTagline: "Small-batch soy candles from Amsterdam.",
  vibe: "classic" as StoreSettings["vibe"], typeStyle: "classic" as StoreSettings["typeStyle"], density: "standard" as StoreSettings["density"],
};

describe("buildRobotsTxt", () => {
  it("allows crawlers, names AI bots, and links the sitemap", () => {
    const txt = buildRobotsTxt(ORIGIN);
    expect(txt).toContain("User-agent: *");
    expect(txt).toContain("Allow: /");
    expect(txt).toContain("User-agent: GPTBot");
    expect(txt).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
  });
});

describe("buildSitemapXml", () => {
  it("lists home + product + collection URLs as valid XML", async () => {
    const xml = await buildSitemapXml("s1", ORIGIN);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain("<loc>https://ember.calderyncompany.com/storefront</loc>");
    expect(xml).toContain("<loc>https://ember.calderyncompany.com/storefront/products/cedar-bloom</loc>");
    expect(xml).toContain("<loc>https://ember.calderyncompany.com/storefront/collections/soy</loc>");
  });
});

describe("buildLlmsTxt", () => {
  it("summarizes the store and lists products with prices for answer engines", async () => {
    const txt = await buildLlmsTxt("s1", store, ORIGIN);
    expect(txt).toContain("# Ember House");
    expect(txt).toContain("Small-batch soy candles from Amsterdam.");
    expect(txt).toContain("[Cedar Bloom](https://ember.calderyncompany.com/storefront/products/cedar-bloom)");
    expect(txt).toContain("32.00 EUR");
    expect(txt).toContain("Out of stock"); // vanilla is unavailable
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run app/lib/seo/__tests__/site-files.server.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `site-files.server.ts`**

```ts
// app/lib/seo/site-files.server.ts
// Public per-tenant text/xml files. Generated from the owned catalog; failure-isolated by callers.
import { getCatalog } from "~/lib/storefront/catalog.server";
import type { StoreSettings } from "~/lib/storefront/settings.server";

const AI_BOTS_ALLOWED = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "PerplexityBot", "Google-Extended"];

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function buildRobotsTxt(origin: string): string {
  const aiBlocks = AI_BOTS_ALLOWED.map((b) => `User-agent: ${b}\nAllow: /`).join("\n\n");
  return [
    "User-agent: *",
    "Allow: /",
    "",
    "# AI assistants are welcome to read and cite this store.",
    aiBlocks,
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");
}

export async function buildSitemapXml(shopId: string, origin: string): Promise<string> {
  const catalog = getCatalog();
  const [products, collections] = await Promise.all([
    catalog.listProducts(shopId),
    catalog.listCollections(shopId),
  ]);
  const locs = [
    `${origin}/storefront`,
    ...collections.map((c) => `${origin}/storefront/collections/${c.handle}`),
    ...products.map((p) => `${origin}/storefront/products/${p.handle}`),
  ];
  const urls = locs.map((loc) => `  <url><loc>${xmlEscape(loc)}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export async function buildLlmsTxt(shopId: string, store: StoreSettings, origin: string): Promise<string> {
  const products = await getCatalog().listProducts(shopId);
  const lines: string[] = [
    `# ${store.storeName}`,
    "",
    `> ${store.voiceTagline?.trim() || `Browse ${store.storeName}.`}`,
    "",
    `Store: ${origin}/storefront`,
    "",
    "## Products",
  ];
  for (const p of products) {
    const url = `${origin}/storefront/products/${p.handle}`;
    const sellable = p.variants.filter((v) => v.priceCents > 0);
    const priceCents = sellable.length ? Math.min(...sellable.map((v) => v.priceCents)) : 0;
    const currency = sellable[0]?.currency ?? "";
    const available = p.variants.some((v) => v.available);
    const price = priceCents ? `${(priceCents / 100).toFixed(2)} ${currency}` : "Not for sale";
    const stock = available ? "In stock" : "Out of stock";
    lines.push(`- [${p.title}](${url}): ${price}, ${stock}`);
  }
  lines.push("");
  return lines.join("\n");
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npx vitest run app/lib/seo/__tests__/site-files.server.test.ts`
Expected: PASS (3 blocks).

- [ ] **Step 5: Commit**

```bash
git add app/lib/seo/site-files.server.ts app/lib/seo/__tests__/site-files.server.test.ts
git commit -m "seo: add robots.txt, sitemap.xml and llms.txt builders"
```

---

### Task 9: Wire the product page (PDP) meta + JSON-LD

**Files:**
- Modify: `app/routes/storefront.products.$handle.tsx` (loader builds `seoMeta`, `meta` export returns it)
- Test: `app/lib/seo/__tests__/pdp-meta.test.ts`

**Interfaces:**
- Consumes: `buildProductDraft` (writer), `metaFromDraft` (render), `storefrontOrigin` (origin), `getStoreSettings` (`~/lib/storefront/settings.server`).
- Produces: the PDP loader now returns `seoMeta: MetaDescriptor[]` in its JSON; `meta` returns `data.seoMeta`.

- [ ] **Step 1: Add the composition guard test**

The route wiring composes already-tested units (writer from Task 3, render from Task 6), so this is an integration guard that passes as soon as those tasks are done. Do NOT export a composing helper from the route module: a non-`loader`/`action` export that imports a `.server` module fails Remix's client build. Compose inline in the loader (the same pattern this route already uses for `catalog.server`).

```ts
// app/lib/seo/__tests__/pdp-meta.test.ts
import { describe, it, expect } from "vitest";
import { buildProductDraft } from "../writer.server";
import { metaFromDraft } from "../render.server";
import type { StoreProduct } from "~/lib/storefront/catalog";
import type { StoreSettings } from "~/lib/storefront/settings.server";

const store: StoreSettings = {
  shopId: "s1", storeName: "Ember House", logoUrl: null,
  palette: { primary: "#111", background: "#fff", text: "#111" },
  voiceTagline: "Candles.", vibe: "classic" as StoreSettings["vibe"], typeStyle: "classic" as StoreSettings["typeStyle"], density: "standard" as StoreSettings["density"],
};
const product: StoreProduct = {
  id: "p1", handle: "cedar-bloom", title: "Cedar Bloom Candle", description: "Soy candle.",
  images: [{ url: "https://img/1.webp", alt: null }],
  variants: [{ id: "v1", sku: "CB", title: "8oz", priceCents: 3200, currency: "EUR", available: true }],
  collections: [],
};

describe("PDP meta composition", () => {
  it("returns descriptors with the product title, canonical and a Product JSON-LD", () => {
    const m = metaFromDraft(buildProductDraft(product, store, "https://ember.calderyncompany.com"));
    expect(m).toContainEqual({ title: "Cedar Bloom Candle · Ember House" });
    expect(m).toContainEqual({ tagName: "link", rel: "canonical", href: "https://ember.calderyncompany.com/storefront/products/cedar-bloom" });
    expect(m.some((d) => "script:ld+json" in (d as object))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the guard test**

Run: `npx vitest run app/lib/seo/__tests__/pdp-meta.test.ts`
Expected: PASS (composes the Task 3 + Task 6 units). If it fails, those tasks are incomplete.

- [ ] **Step 3: Edit `app/routes/storefront.products.$handle.tsx`**

Add imports near the existing imports:

```ts
import { getStoreSettings } from "~/lib/storefront/settings.server";
import { buildProductDraft } from "~/lib/seo/writer.server";
import { metaFromDraft } from "~/lib/seo/render.server";
import { storefrontOrigin } from "~/lib/seo/origin.server";
```

Replace the existing `meta` export (currently building a bare title/description) with a passthrough of the loader-built descriptors:

```ts
export const meta: MetaFunction<typeof loader> = ({ data }) => data?.seoMeta ?? [{ title: "Product" }];
```

In the `loader`, after `product` is resolved and before the existing `return json(...)`, build the meta server-side and add `seoMeta` to the payload (keep the existing `track`/headers exactly):

```ts
  const settings = await getStoreSettings(shopId);
  const seoMeta = metaFromDraft(buildProductDraft(product, settings, storefrontOrigin(request)));
  return json({ product, doc, data, record, demo: shopId === DEMO_SHOP_ID, seoMeta }, { headers: track });
```

Leave the legacy gallery `alt={img.alt ?? product.title}` as-is (already non-empty). Persisting generated per-image alt is a Plan B concern; the crawl-visible alt lives in the JSON-LD and meta, which this task covers.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add app/routes/storefront.products.$handle.tsx app/lib/seo/__tests__/pdp-meta.test.ts
git commit -m "storefront/pdp: serve full SEO meta + Product JSON-LD"
```

---

### Task 10: Wire the home page and collection page

**Files:**
- Modify: `app/routes/storefront._index.tsx` (home meta + Organization/WebSite JSON-LD)
- Modify: `app/routes/storefront.collections.$handle.tsx` (collection meta + CollectionPage JSON-LD)
- Test: `app/lib/seo/__tests__/home-collection-meta.test.ts` (lib composition guard; no route-module import)

**Interfaces:**
- Consumes: `buildHomeDraft`, `buildCollectionDraft` (writer), `metaFromDraft` (render), `storefrontOrigin`, `getStoreSettings`.
- Produces: both loaders add `seoMeta` to their JSON payload; both `meta` exports return `data.seoMeta`.

Same rule as Task 9: compose inline in each loader; do not export helpers from the route modules.

- [ ] **Step 1: Add the composition guard test**

```ts
// app/lib/seo/__tests__/home-collection-meta.test.ts
import { describe, it, expect } from "vitest";
import { buildHomeDraft, buildCollectionDraft } from "../writer.server";
import { metaFromDraft } from "../render.server";
import type { StoreSettings } from "~/lib/storefront/settings.server";

const store: StoreSettings = {
  shopId: "s1", storeName: "Ember House", logoUrl: "https://l/x.png",
  palette: { primary: "#111", background: "#fff", text: "#111" },
  voiceTagline: "Small-batch soy candles from Amsterdam.",
  vibe: "classic" as StoreSettings["vibe"], typeStyle: "classic" as StoreSettings["typeStyle"], density: "standard" as StoreSettings["density"],
};
const ORIGIN = "https://ember.calderyncompany.com";

describe("home + collection meta composition", () => {
  it("home carries Organization + WebSite JSON-LD", () => {
    const m = metaFromDraft(buildHomeDraft(store, ORIGIN));
    const types = m.filter((d) => "script:ld+json" in (d as object)).map((d) => (d as Record<string, { "@type": string }>)["script:ld+json"]["@type"]);
    expect(types.sort()).toEqual(["Organization", "WebSite"]);
  });
  it("collection canonical targets the collection path", () => {
    const m = metaFromDraft(buildCollectionDraft({ handle: "soy", title: "Soy Candles" }, store, ORIGIN));
    expect(m).toContainEqual({ tagName: "link", rel: "canonical", href: `${ORIGIN}/storefront/collections/soy` });
  });
});
```

- [ ] **Step 2: Run the guard test**

Run: `npx vitest run app/lib/seo/__tests__/home-collection-meta.test.ts`
Expected: PASS.

- [ ] **Step 3: Edit `storefront._index.tsx`**

Add imports:

```ts
import { getStoreSettings } from "~/lib/storefront/settings.server";
import { buildHomeDraft } from "~/lib/seo/writer.server";
import { metaFromDraft } from "~/lib/seo/render.server";
import { storefrontOrigin } from "~/lib/seo/origin.server";
```

Set `meta` to a passthrough (add `MetaFunction` to the existing `@remix-run/node` type import if it is not already there):

```ts
export const meta: MetaFunction<typeof loader> = ({ data }) => data?.seoMeta ?? [{ title: "Store" }];
```

In the loader, resolve settings + origin and add `seoMeta` to the returned JSON. Reuse an already-loaded settings object if the loader has one; otherwise add the read. Keep all existing fields and headers:

```ts
  const settings = await getStoreSettings(shopId);
  const seoMeta = metaFromDraft(buildHomeDraft(settings, storefrontOrigin(request)));
  return json({ /* ...existing fields... */ seoMeta }, { headers: track });
```

- [ ] **Step 4: Edit `storefront.collections.$handle.tsx`**

Add the same four seo imports, but `buildCollectionDraft` instead of `buildHomeDraft`. Set `meta`:

```ts
export const meta: MetaFunction<typeof loader> = ({ data }) => data?.seoMeta ?? [{ title: "Collection" }];
```

In the loader, after the collection is resolved, build and add `seoMeta` (map the loader's real collection fields; pass `description: null` if the collection object has none):

```ts
  const settings = await getStoreSettings(shopId);
  const seoMeta = metaFromDraft(buildCollectionDraft(
    { handle: collection.handle, title: collection.title, description: (collection as { description?: string | null }).description ?? null },
    settings,
    storefrontOrigin(request),
  ));
  return json({ /* ...existing fields... */ seoMeta }, { headers: track });
```

- [ ] **Step 5: Run the guard test again + typecheck**

Run: `npx vitest run app/lib/seo/__tests__/home-collection-meta.test.ts` then `npm run typecheck`
Expected: PASS, then exit 0.

- [ ] **Step 6: Commit**

```bash
git add app/routes/storefront._index.tsx app/routes/storefront.collections.$handle.tsx app/lib/seo/__tests__/home-collection-meta.test.ts
git commit -m "storefront/home+collection: serve meta + Organization/WebSite/CollectionPage JSON-LD"
```

---

### Task 11: Resource routes + root-layout crawl logging

**Files:**
- Create: `app/routes/[sitemap.xml].tsx`
- Create: `app/routes/[robots.txt].tsx`
- Create: `app/routes/[llms.txt].tsx`
- Modify: `app/routes/storefront.tsx` (log AI-crawler hits for all storefront pages)
- Test: `app/routes/__tests__/seo-resource-routes.test.ts`

**Interfaces:**
- Consumes: `buildSitemapXml`, `buildRobotsTxt`, `buildLlmsTxt` (site-files); `resolveStorefrontShop` (`~/lib/storefront/shop.server`); `getStoreSettings`; `storefrontOrigin`; `detectAiBot`, `logAiCrawl` (crawlers).
- Produces: three loader-only routes returning raw `Response`s; the storefront root loader now fires `logAiCrawl` as a side effect.

- [ ] **Step 1: Write the failing test** (drive each loader directly with a Request)

```ts
// app/routes/__tests__/seo-resource-routes.test.ts
import { describe, it, expect, vi } from "vitest";

vi.mock("~/lib/storefront/shop.server", () => ({ resolveStorefrontShop: async () => "s1", DEMO_SHOP_ID: "demo-shop" }));
vi.mock("~/lib/storefront/settings.server", () => ({
  getStoreSettings: async () => ({ shopId: "s1", storeName: "Ember House", logoUrl: null, palette: { primary: "#111", background: "#fff", text: "#111" }, voiceTagline: "Candles.", vibe: "classic", typeStyle: "classic", density: "standard" }),
}));
vi.mock("~/lib/seo/site-files.server", () => ({
  buildRobotsTxt: (origin: string) => `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`,
  buildSitemapXml: async () => '<?xml version="1.0" encoding="UTF-8"?><urlset></urlset>',
  buildLlmsTxt: async () => "# Ember House\n",
}));

// eslint-disable-next-line import/first
import { loader as robots } from "../[robots.txt]";
// eslint-disable-next-line import/first
import { loader as sitemap } from "../[sitemap.xml]";
// eslint-disable-next-line import/first
import { loader as llms } from "../[llms.txt]";

function req(host = "ember.calderyncompany.com") {
  return { request: new Request(`https://${host}/x`, { headers: { host } }), params: {}, context: {} };
}

describe("seo resource routes", () => {
  it("robots.txt is text/plain and links the sitemap", async () => {
    const res = await robots(req() as never);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain("Sitemap: https://ember.calderyncompany.com/sitemap.xml");
  });
  it("sitemap.xml is application/xml", async () => {
    const res = await sitemap(req() as never);
    expect(res.headers.get("content-type")).toContain("application/xml");
    expect(await res.text()).toContain("<urlset");
  });
  it("llms.txt is text/plain and starts with the store name heading", async () => {
    const res = await llms(req() as never);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain("# Ember House");
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run app/routes/__tests__/seo-resource-routes.test.ts`
Expected: FAIL (route modules not found).

- [ ] **Step 3: Implement `[robots.txt].tsx`**

```ts
// app/routes/[robots.txt].tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { buildRobotsTxt } from "~/lib/seo/site-files.server";
import { storefrontOrigin } from "~/lib/seo/origin.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const body = buildRobotsTxt(storefrontOrigin(request));
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}
```

- [ ] **Step 4: Implement `[sitemap.xml].tsx`**

```ts
// app/routes/[sitemap.xml].tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { resolveStorefrontShop } from "~/lib/storefront/shop.server";
import { buildSitemapXml } from "~/lib/seo/site-files.server";
import { storefrontOrigin } from "~/lib/seo/origin.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  const body = await buildSitemapXml(shopId, storefrontOrigin(request));
  return new Response(body, {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}
```

- [ ] **Step 5: Implement `[llms.txt].tsx`**

```ts
// app/routes/[llms.txt].tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { resolveStorefrontShop } from "~/lib/storefront/shop.server";
import { getStoreSettings } from "~/lib/storefront/settings.server";
import { buildLlmsTxt } from "~/lib/seo/site-files.server";
import { storefrontOrigin } from "~/lib/seo/origin.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  const store = await getStoreSettings(shopId);
  const body = await buildLlmsTxt(shopId, store, storefrontOrigin(request));
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}
```

- [ ] **Step 6: Add crawl logging to `storefront.tsx`**

In the root storefront loader (`app/routes/storefront.tsx`, the `loader` at ~line 59), add the side effect after `shopId` is resolved. Add imports:

```ts
import { detectAiBot, logAiCrawl } from "~/lib/seo/crawlers.server";
```

Inside the loader, after `const shopId = await resolveStorefrontShop(request);`:

```ts
  // AIO signal: record when a known AI assistant crawler reads any storefront page.
  const aiBot = detectAiBot(request.headers.get("user-agent"));
  if (aiBot) void logAiCrawl(shopId, aiBot);
```

(`void` + the logger's internal try/catch keep this from ever blocking or breaking the render.)

- [ ] **Step 7: Run it, verify it passes**

Run: `npx vitest run app/routes/__tests__/seo-resource-routes.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 8: Commit**

```bash
git add "app/routes/[sitemap.xml].tsx" "app/routes/[robots.txt].tsx" "app/routes/[llms.txt].tsx" app/routes/storefront.tsx app/routes/__tests__/seo-resource-routes.test.ts
git commit -m "storefront: serve sitemap.xml/robots.txt/llms.txt and log AI-crawler visits"
```

---

### Task 12: Full gate, apply migration, live verification

**Files:** none (verification + prod migration apply)

**Interfaces:** none.

- [ ] **Step 1: Run the whole seo test suite**

Run: `npx vitest run app/lib/seo app/routes/__tests__/seo-resource-routes.test.ts`
Expected: PASS (all tasks' tests green).

- [ ] **Step 2: Pre-commit gate**

Run in order, each must exit 0:
```bash
npm run typecheck
npm run lint
npm run build
```
If lint flags the new files, fix at the source (do not add `eslint-disable` beyond the `import/first` lines the mock pattern requires, which mirror `events.server.test.ts`).

- [ ] **Step 3: Apply the migration to prod** (OUTWARD, hard-to-reverse — confirm before running)

This writes to the prod Supabase project `ajgrmnvzxfxxlwrxcgnu`. Apply via the supabase MCP:
`mcp__supabase__apply_migration` with name `seo_ai_crawl` and the SQL from Task 7 Step 1.
Then verify RLS coverage: `node scripts/verify-rls.mjs` (expect `seo_ai_crawl_daily` present and no drift warning).

Note: the storefront code is safe to deploy before this runs — `logAiCrawl` swallows the "relation/function does not exist" error until the table is live. Nothing else in Plan A reads the table.

- [ ] **Step 4: Live smoke (drive the real storefront)**

Against the running app (local dev or a deploy preview), confirm with the demo store host:
- `GET /robots.txt` returns text with a `Sitemap:` line and `User-agent: GPTBot`.
- `GET /sitemap.xml` returns XML with `<loc>` entries for `/storefront` and product paths.
- `GET /llms.txt` returns the `# <store>` summary with product lines and prices.
- `GET /storefront/products/<handle>`: view source shows `<title>`, `<meta name="description">`, `<link rel="canonical">`, `og:*`, `twitter:card`, and a `<script type="application/ld+json">` Product block. Paste that JSON-LD into Google's Rich Results Test (search.google.com/test/rich-results) and confirm the Product parses with no errors.
- `curl -A "GPTBot/1.1" <host>/storefront/products/<handle>` then confirm (Plan B will surface it) a `seo_ai_crawl_daily` row exists: `select * from seo_ai_crawl_daily` via the supabase MCP.

- [ ] **Step 5: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "seo: gate fixes and verification for Plan A"
```

---

## Self-review (author check against the spec)

**Spec coverage (Plan A scope only — Plan B/C carry the rest):**
- Meta title/description/canonical/OG/Twitter -> Tasks 3, 6, 9, 10. ✓
- JSON-LD Product/Offer/AggregateOffer, Organization, WebSite, CollectionPage, Breadcrumb -> Tasks 2, 3, 9, 10. ✓
- Image alt text generation -> Task 3 (`imageAlts`); crawl-visible surface served via JSON-LD/meta. Persistence of per-image overrides is deferred to Plan B (noted in Task 9). ✓ (scoped)
- sitemap.xml / robots.txt / llms.txt -> Tasks 8, 11. ✓
- Allow AI crawlers in robots (citation) -> Task 8 (`buildRobotsTxt`). The allow/deny toggle is Plan B (Task 8 defaults to allow). ✓ (scoped)
- AI-crawler detection + logging (AIO measurement) -> Task 7 (+ root wiring Task 11). ✓
- Validator gates invalid schema -> Task 4; wired into score Task 5. Enforcement-on-publish is Plan B (nothing is "published" in Plan A; live generation always runs the writer, and the validator/score are exposed for Plan B's editor). ✓ (scoped)
- Health score rubric -> Task 5. ✓
- Failure isolation on storefront -> `logAiCrawl` swallows errors (Task 7); resource routes and meta come from pure builders; a settings/catalog hiccup surfaces as a normal loader error like today. Consider wrapping the added loader reads in the existing try/catch idiom if a store with no settings can occur — noted for the implementer.
- Multi-tenant scoping -> every builder takes `shopId`/`origin` resolved from the request; demo shop uses the fixture catalog and `logAiCrawl` no-ops on the non-UUID id. ✓
- Deterministic-first writer, no Claude on hot path -> Task 3. ✓ (Claude enhancement intentionally out of Plan A.)

**Not in Plan A (correctly deferred):** `seo_page`/`seo_settings` tables, the Search dashboard screen, per-product overrides + editor, auto-write on product save, batch backfill (all Plan B); `seo_ranking`, Google Search Console, cron, auto-rewrite (Plan C).

**Placeholder scan:** no TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `SeoDraft`/`HealthReport`/`AiBotName` used identically across Tasks 1-11; `metaFromDraft` returns `MetaDescriptor[]` consumed by Tasks 9-10; `buildProductDraft/buildHomeDraft/buildCollectionDraft` signatures match the shared contract. ✓

**Open implementer notes (not blockers):**
- Tasks 9-10 say "add `seoMeta` to the existing json payload" — the implementer must read each loader's current return object and spread its real fields (shown as `...existingFields`). The exact fields differ per route; do not drop existing keys or headers.
- If a route's collection object does not carry a description, pass `description: null` (writer falls back to a template).
