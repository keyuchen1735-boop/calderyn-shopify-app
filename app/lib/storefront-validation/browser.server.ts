import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import axeSourceText from "axe-core/axe.min.js?raw";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";
import type { Browser, HTTPRequest, Page } from "puppeteer-core";
import { launchChromium } from "../browser/chromium.server";
import type { BrowserProofReport, MaterializedAssetResult, MerchantStorefrontContext } from "../storefront-ai/contracts";
import type { StorefrontBundleV1, StorefrontRouteId } from "../storefront-bundle/types";
import { getStoreTemplate, isStoreTemplateId } from "../storefront-bundle/registry";
import type { StorefrontCatalog, StoreProduct } from "../storefront/catalog";
import { decodeProductPageCursor, encodeProductPageCursor } from "../storefront/catalog";
import { searchProductPageInMemory } from "../storefront/catalog.stub.server";
import { parseStorefrontCollectionParams, parseStorefrontSearchParams } from "../storefront/search.server";
import { StorefrontPolicyPage } from "../storefront/policy-page";
import { resolveStorefrontPolicyPath, type StorefrontPolicy } from "../storefront/policies.server";
import { renderStorefrontSurface } from "../storefront-runtime/render.server";
import { resolveStorefrontVisualPlacement } from "../storefront-runtime/visual-layer.server";
import {
  resolvePublicData,
  type PublicPresentationData,
  type PublicProduct,
} from "../storefront-runtime/public-data.server";
import { createStorefrontProofData, storefrontProofPolicies } from "./fixtures";
import { verifyStorefrontPolicyRoutes } from "./policy-routes";
import {
  createBrowserProofReport,
  type StorefrontBrowserDiagnostic,
  type StorefrontBrowserMetrics,
  type StorefrontBrowserProofReport,
  type StorefrontProofViewportName,
} from "./report";

export const STOREFRONT_PROOF_VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 1000 },
] as const;

export const STOREFRONT_PROOF_ROUTES = ["home", "collection", "product", "search", "cart", "checkout"] as const;

const PROOF_ORIGIN = "https://storefront-proof.local";
const PROOF_SHOP_ID = "11111111-1111-4111-8111-111111111111";
const PROOF_NONCE = "storefront-proof-nonce";
const ROUTE_BYTES_LIMIT = 250 * 1024;
const INTERACTION_BYTES_LIMIT = 40 * 1024;
const FULL_BUNDLE_BYTES_LIMIT = 1.5 * 1024 * 1024;
const CATALOG_PAGE_SIZE = 24;
const STOREFRONT_PROOF_ROUTE_RE = /^\/storefront(?:\/(?:collections|products|search|cart|checkout|account)(?:[/?#].*)?|\/policies\/(?:privacy|terms|refund|shipping)\/?(?:[?#].*)?)?$/;
let proofRuntimeSource: Promise<string> | undefined;

export function isSupportedStorefrontProofLink(href: string): boolean {
  return STOREFRONT_PROOF_ROUTE_RE.test(href);
}

export interface StorefrontProofCase {
  routeId: StorefrontRouteId;
  viewport: (typeof STOREFRONT_PROOF_VIEWPORTS)[number];
  catalogOffset: number;
}

export interface StorefrontProofArtifacts {
  baselineDirectory?: string;
  previewFile?: string;
  updateBaselines?: boolean;
}

export interface StorefrontProofExpectations {
  generatedImageUrls?: readonly string[];
  home?: {
    heroText?: string;
    featuredProductIds?: readonly string[];
    visualLayer?: "canvas" | "fallback";
  };
}

export interface ProveStorefrontBundleInput {
  bundle: StorefrontBundleV1;
  context?: MerchantStorefrontContext;
  persistedAssets?: MaterializedAssetResult["proofAssets"];
  signal?: AbortSignal;
  timeoutMs?: number;
  browser?: Browser;
  artifacts?: StorefrontProofArtifacts;
  routes?: readonly StorefrontRouteId[];
  catalogPagination?: boolean;
  catalog?: StorefrontCatalog;
  viewports?: readonly StorefrontProofViewportName[];
  expectations?: StorefrontProofExpectations;
  onProgress?: (event: { routeId: StorefrontRouteId; viewport: StorefrontProofViewportName; completed: number; total: number }) => void;
}

export function shouldWriteStorefrontPreview(
  routeId: StorefrontRouteId,
  viewport: StorefrontProofViewportName,
  artifacts?: StorefrontProofArtifacts,
): boolean {
  return shouldVerifyStorefrontPreview(routeId, viewport, artifacts) && Boolean(artifacts?.updateBaselines);
}

export function shouldVerifyStorefrontPreview(
  routeId: StorefrontRouteId,
  viewport: StorefrontProofViewportName,
  artifacts?: StorefrontProofArtifacts,
): boolean {
  return routeId === "home" && viewport === "desktop" && Boolean(artifacts?.previewFile);
}

export interface ProveStorefrontBundleResult extends StorefrontBrowserProofReport {
  screenshotManifest: Array<{
    routeId: StorefrontRouteId;
    viewport: StorefrontProofViewportName;
    sha256: string;
    catalogOffset?: number;
    baseline?: string;
    pixelDiffRatio?: number;
  }>;
}

export function buildStorefrontProofCases(
  _bundle: StorefrontBundleV1,
  routes: readonly StorefrontRouteId[] = STOREFRONT_PROOF_ROUTES,
  options?: {
    catalogProductCount?: number;
    viewports?: readonly StorefrontProofViewportName[];
  },
): StorefrontProofCase[] {
  const selectedViewports = options?.viewports
    ? STOREFRONT_PROOF_VIEWPORTS.filter(({ name }) => options.viewports?.includes(name))
    : STOREFRONT_PROOF_VIEWPORTS;
  return routes.flatMap((routeId) => {
    const pageCount = (routeId === "collection" || routeId === "search")
      && options?.catalogProductCount !== undefined
      ? Math.max(1, Math.ceil(options.catalogProductCount / CATALOG_PAGE_SIZE))
      : 1;
    return Array.from({ length: pageCount }, (_, index) => index * CATALOG_PAGE_SIZE)
      .flatMap((catalogOffset) => selectedViewports.map((viewport) => ({ routeId, viewport, catalogOffset })));
  });
}

export function detectFullStoryFailures(input: {
  routeId: StorefrontRouteId;
  expectedProductDescription: string | null;
  expectedHeroText?: string;
  expectedFeaturedProductIds?: readonly string[];
  renderedText: string;
  renderedHeroTexts?: readonly string[];
  renderedFeaturedProductIds?: readonly string[];
  hasVisualCanvas: boolean;
  hasProtectedFallback: boolean;
  visualExpectation: "canvas" | "fallback" | null;
}): string[] {
  const failures: string[] = [];
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  if (input.routeId === "product" && input.expectedProductDescription
    && !normalize(input.renderedText).includes(normalize(input.expectedProductDescription))) {
    failures.push("product-description-incomplete");
  }
  if (input.routeId === "home" && input.expectedHeroText !== undefined) {
    const expected = normalize(input.expectedHeroText);
    const matches = input.renderedHeroTexts
      ? input.renderedHeroTexts.some((text) => normalize(text) === expected)
      : normalize(input.renderedText).includes(expected);
    if (!matches) failures.push("hero-text-missing");
  }
  if (input.routeId === "home" && input.expectedFeaturedProductIds !== undefined) {
    const rendered = input.renderedFeaturedProductIds ?? [];
    if (rendered.length !== input.expectedFeaturedProductIds.length
      || rendered.some((id, index) => id !== input.expectedFeaturedProductIds?.[index])) {
      failures.push("featured-products-order-mismatch");
    }
  }
  if (input.routeId === "home" && input.visualExpectation === "canvas") {
    if (!input.hasVisualCanvas) failures.push("visual-canvas-missing");
    if (input.hasProtectedFallback) failures.push("protected-fallback-visible");
  }
  if (input.routeId === "home" && input.visualExpectation === "fallback") {
    if (input.hasVisualCanvas) failures.push("visual-canvas-unexpected");
    if (!input.hasProtectedFallback) failures.push("protected-fallback-missing");
  }
  return failures;
}

export interface StorefrontBuyerFlowRequest {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

export function detectBuyerFlowFailures(input: {
  routeId: StorefrontRouteId;
  requests: readonly StorefrontBuyerFlowRequest[];
  navigation: string | null;
  refreshCount: number;
  initialCartCount: number;
  finalCartCount: number;
  expectedVariantId?: string;
  expectedCartLine?: { id: string; quantity: number };
}): string[] {
  const failures: string[] = [];
  const post = (url: string) => input.requests.find((request) =>
    request.url === url && request.method === "POST");

  if (input.routeId === "product" && input.expectedVariantId) {
    const add = post("/storefront/api/cart/add");
    if (!add
      || add.body.variantId !== input.expectedVariantId
      || add.body.quantity !== 1) failures.push("cart-add-request-missing");
    if (input.finalCartCount !== input.initialCartCount + 1) failures.push("cart-state-unchanged");
    if (input.refreshCount < 1) failures.push("cart-refresh-missing");
  }

  if (input.routeId === "cart") {
    if (input.expectedCartLine) {
      const quantity = post("/storefront/api/cart/quantity");
      if (!quantity
        || quantity.body.lineId !== input.expectedCartLine.id
        || quantity.body.quantity !== input.expectedCartLine.quantity + 1) {
        failures.push("cart-quantity-request-missing");
      }
      const remove = post("/storefront/api/cart/remove");
      if (!remove || remove.body.lineId !== input.expectedCartLine.id) {
        failures.push("cart-remove-request-missing");
      }
      if (input.finalCartCount >= input.initialCartCount) failures.push("cart-state-unchanged");
      if (input.refreshCount < 2) failures.push("cart-refresh-missing");
    }
    if (input.navigation !== "/storefront/checkout") failures.push("checkout-navigation-missing");
  }

  if (input.routeId === "checkout") {
    const checkout = post("/storefront/checkout");
    if (!checkout
      || checkout.body.intent !== "quote"
      || checkout.body.email !== "buyer@example.test") failures.push("checkout-submit-missing");
    if (input.refreshCount < 1) failures.push("checkout-response-missing");
  }

  return failures;
}

export function detectCatalogPaginationFailure(
  expectedIds: readonly string[],
  observedPages: readonly (readonly string[])[],
): { code: "catalog.pagination"; detail: { pageSizes: number[]; total: number; unique: number; expected: number } } | null {
  const pageSizes = observedPages.map((page) => page.length);
  const observedIds = observedPages.flatMap((page) => [...page]);
  const expectedPageSizes = Array.from(
    { length: Math.max(1, Math.ceil(expectedIds.length / CATALOG_PAGE_SIZE)) },
    (_, index) => Math.min(CATALOG_PAGE_SIZE, Math.max(0, expectedIds.length - index * CATALOG_PAGE_SIZE)),
  );
  const exact = pageSizes.length === expectedPageSizes.length
    && pageSizes.every((size, index) => size === expectedPageSizes[index])
    && observedIds.length === expectedIds.length
    && new Set(observedIds).size === expectedIds.length
    && expectedIds.every((id) => observedIds.includes(id));
  return exact ? null : {
    code: "catalog.pagination",
    detail: {
      pageSizes,
      total: observedIds.length,
      unique: new Set(observedIds).size,
      expected: expectedIds.length,
    },
  };
}

function routeBytes(bundle: StorefrontBundleV1, routeId: StorefrontRouteId): number {
  const artifact = bundle.routes[routeId];
  if (routeId === "checkout") {
    const checkout = artifact as StorefrontBundleV1["routes"]["checkout"];
    return Buffer.byteLength(checkout.decorativeHtml) + Buffer.byteLength(checkout.decorativeCss);
  }
  const route = artifact as StorefrontBundleV1["routes"][Exclude<StorefrontRouteId, "checkout">];
  return Buffer.byteLength(route.html) + Buffer.byteLength(route.css);
}

function interactionBytes(bundle: StorefrontBundleV1, routeId: StorefrontRouteId): number {
  if (routeId === "checkout") return 0;
  return Buffer.byteLength(JSON.stringify(bundle.routes[routeId].interactions));
}

export function measureStorefrontBundle(bundle: StorefrontBundleV1): StorefrontBrowserMetrics {
  return {
    routeHtmlCssBytes: Object.fromEntries(STOREFRONT_PROOF_ROUTES.map((routeId) => [routeId, routeBytes(bundle, routeId)])),
    interactionBytes: Object.fromEntries(STOREFRONT_PROOF_ROUTES.map((routeId) => [routeId, interactionBytes(bundle, routeId)])),
    fullBundleBytes: Buffer.byteLength(JSON.stringify(bundle)),
  };
}

export function validateStorefrontBundleBudgets(bundle: StorefrontBundleV1): StorefrontBrowserProofReport {
  const metrics = measureStorefrontBundle(bundle);
  const diagnostics: StorefrontBrowserDiagnostic[] = [];
  for (const routeId of STOREFRONT_PROOF_ROUTES) {
    const bytes = metrics.routeHtmlCssBytes[routeId] ?? 0;
    if (bytes > ROUTE_BYTES_LIMIT) diagnostics.push({
      routeId,
      code: "budget.route-bytes",
      message: `Compiled HTML and CSS is ${bytes} bytes; limit is ${ROUTE_BYTES_LIMIT}`,
      severity: "serious",
      detail: { actual: bytes, limit: ROUTE_BYTES_LIMIT },
    });
    const manifestBytes = metrics.interactionBytes[routeId] ?? 0;
    if (manifestBytes > INTERACTION_BYTES_LIMIT) diagnostics.push({
      routeId,
      code: "budget.interactions",
      message: `Interaction manifest is ${manifestBytes} bytes; limit is ${INTERACTION_BYTES_LIMIT}`,
      severity: "serious",
      detail: { actual: manifestBytes, limit: INTERACTION_BYTES_LIMIT },
    });
  }
  if (metrics.fullBundleBytes > FULL_BUNDLE_BYTES_LIMIT) diagnostics.push({
    routeId: "home",
    code: "budget.bundle-bytes",
    message: `Bundle is ${metrics.fullBundleBytes} bytes; limit is ${FULL_BUNDLE_BYTES_LIMIT}`,
    severity: "serious",
    detail: { actual: metrics.fullBundleBytes, limit: FULL_BUNDLE_BYTES_LIMIT },
  });
  return createBrowserProofReport({ diagnostics, screenshots: [], browserMs: 0, metrics });
}

function presentContextProduct(entry: MerchantStorefrontContext["products"][number], index: number): PublicProduct {
  const fixture = createStorefrontProofData("product").product!;
  const image = entry.images.length === 0 ? null : {
    url: `${PROOF_ORIGIN}/__proof__/catalog/context-${index + 1}.svg`,
    alt: `${entry.title} product photograph`,
  };
  const available = entry.availability !== "sold_out";
  return {
    ...fixture,
    id: entry.id,
    handle: entry.handle,
    title: entry.title,
    primaryImage: image,
    images: image ? [image] : [],
    options: entry.optionNames.map((name) => ({ name, values: ["Natural", "Midnight"] })),
    variants: [
      {
        id: `${entry.id}-variant-natural`,
        title: "Natural",
        price: { cents: entry.priceMin, currency: entry.currency },
        compareAtPrice: entry.priceMax > entry.priceMin ? { cents: entry.priceMax, currency: entry.currency } : null,
        availability: available ? "In stock" : "Sold out",
        available,
      },
      {
        id: `${entry.id}-variant-midnight`,
        title: "Midnight",
        price: { cents: entry.priceMax, currency: entry.currency },
        compareAtPrice: null,
        availability: entry.availability === "available" ? "In stock" : "Sold out",
        available: entry.availability === "available",
      },
    ],
    price: { cents: entry.priceMin, currency: entry.currency },
    compareAtPrice: entry.priceMax > entry.priceMin ? { cents: entry.priceMax, currency: entry.currency } : null,
    availability: available ? "In stock" : "Sold out",
  };
}

export function createStorefrontProofCatalog(
  context: MerchantStorefrontContext,
  readyAssets: readonly { productId: string; url: string }[] = [],
): StorefrontCatalog {
  const collectionHandles = new Map(context.collections.map(({ id, handle }) => [id, handle]));
  const readyUrls = new Map(readyAssets.map(({ productId, url }) => [productId, url]));
  const collections = context.collections.map((collection) => ({
    id: collection.id,
    handle: collection.handle,
    title: collection.title,
    description: `Complete merchant description for ${collection.title}`,
    productCount: collection.productCount,
  }));
  const products = context.products.map((entry, index): StoreProduct => {
    const presented = presentContextProduct(entry, index);
    const readyUrl = entry.images.length === 0 ? readyUrls.get(entry.id) : undefined;
    return {
      id: entry.id,
      handle: entry.handle,
      title: entry.title,
      description: presented.description,
      images: readyUrl ? [{ url: readyUrl, alt: entry.title }] : presented.images,
      options: presented.options,
      variants: presented.variants.map((variant) => ({
        id: variant.id,
        sku: null,
        title: variant.title,
        priceCents: variant.price?.cents ?? entry.priceMin,
        compareAtPriceCents: variant.compareAtPrice?.cents ?? null,
        currency: variant.price?.currency ?? entry.currency,
        available: variant.available,
      })),
      collections: (entry.collectionIds ?? []).flatMap((id) => {
        const handle = collectionHandles.get(id);
        return handle ? [handle] : [];
      }),
      category: entry.productType,
      tags: entry.tags,
    };
  });
  const sorted = () => products.slice().sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
  return {
    searchProductPage: async (_shopId, options) => {
      if (options.sort !== "relevance") return searchProductPageInMemory(products, options);
      const query = options.query.toLocaleLowerCase();
      const selected = products.filter((product) => {
        if (query && !`${product.title} ${product.description} ${product.category ?? ""} ${(product.tags ?? []).join(" ")}`.toLocaleLowerCase().includes(query)) return false;
        if (options.collection && !product.collections.includes(options.collection)) return false;
        return true;
      });
      const start = options.after
        ? Math.max(0, selected.findIndex(({ id }) => id === options.after!.productId) + 1)
        : 0;
      const items = selected.slice(start, start + options.limit);
      const hasNextPage = start + items.length < selected.length;
      const last = items.at(-1);
      return {
        items,
        boundary: hasNextPage && last ? { sortValue: last.title, productId: last.id } : null,
        facets: { categories: [], tags: [], collections: [] },
        total: selected.length,
        hasNextPage,
      };
    },
    listProductPage: async (_shopId, options) => {
      let selected = sorted();
      if (options.collection) selected = selected.filter(({ collections: handles }) => handles.includes(options.collection!));
      if (options.query) {
        const query = options.query.toLocaleLowerCase();
        selected = selected.filter(({ title, description }) => `${title} ${description}`.toLocaleLowerCase().includes(query));
      }
      const cursor = options.cursor ? decodeProductPageCursor(options.cursor) : null;
      const remaining = cursor
        ? selected.filter(({ title, id }) => title.localeCompare(cursor.title) > 0
            || (title === cursor.title && id.localeCompare(cursor.id) > 0))
        : selected;
      const items = remaining.slice(0, options.limit);
      const last = items.at(-1);
      return {
        items,
        nextCursor: last && remaining.length > items.length ? encodeProductPageCursor(last.title, last.id) : null,
      };
    },
    listProducts: async (_shopId, options) => {
      let selected = options?.ids
        ? products.filter(({ id }) => options.ids!.includes(id))
        : products;
      if (options?.collection) selected = selected.filter(({ collections: handles }) => handles.includes(options.collection!));
      return options?.limit === undefined ? selected : selected.slice(0, options.limit);
    },
    getProduct: async (_shopId, handle) => products.find((product) => product.handle === handle) ?? null,
    getCollection: async (_shopId, handle) => collections.find((collection) => collection.handle === handle) ?? null,
    listCollections: async () => collections,
  };
}

async function resolveStorefrontProofCatalogPages(
  routeId: "collection" | "search",
  context: MerchantStorefrontContext,
  catalog: StorefrontCatalog,
): Promise<PublicPresentationData[]> {
  const pageCount = Math.max(1, Math.ceil(context.products.length / CATALOG_PAGE_SIZE));
  const pages: PublicPresentationData[] = [];
  let cursor: string | null = null;
  for (let index = 0; index < pageCount; index++) {
    const params = new URLSearchParams({ limit: String(CATALOG_PAGE_SIZE) });
    if (cursor) params.set("cursor", cursor);
    if (routeId === "search") params.set("q", "studio");
    const collectionHandle = context.collections[0]?.handle ?? "proof-collection";
    const searchInput = routeId === "collection"
      ? parseStorefrontCollectionParams(params, collectionHandle)
      : parseStorefrontSearchParams(params);
    const production = await resolvePublicData({
      shopId: PROOF_SHOP_ID,
      requiredData: routeId === "collection"
        ? [{ kind: "currentCollection" }]
        : [{ kind: "searchResults", limit: CATALOG_PAGE_SIZE }],
      route: routeId === "collection"
        ? { kind: "collection", handle: collectionHandle, searchInput }
        : { kind: "search", query: "", searchInput },
    }, {
      catalog,
      settingsLoader: async () => ({
        shopId: PROOF_SHOP_ID,
        storeName: context.store.name,
        logoUrl: null,
        palette: { primary: "#111111", background: "#ffffff", text: "#111111" },
        voiceTagline: null,
        vibe: "minimal",
        typeStyle: "classic",
        density: "standard",
      }),
    });
    const fixture = createStorefrontProofData(routeId);
    pages.push({
      ...fixture,
      store: production.store,
      collection: routeId === "collection" && production.collection && fixture.collection
        ? { ...production.collection, description: fixture.collection.description, image: fixture.collection.image }
        : null,
      search: routeId === "search" && production.search && fixture.search
        ? { ...production.search, facets: fixture.search.facets }
        : null,
    });
    cursor = routeId === "collection"
      ? production.collection?.nextCursor ?? null
      : production.search?.nextCursor ?? null;
  }
  return pages;
}

export function createStorefrontProofDataForContext(
  routeId: StorefrontRouteId,
  context?: MerchantStorefrontContext,
  featuredProductIds?: readonly string[],
  featuredProductLimit = 12,
  catalogOffset = 0,
): PublicPresentationData {
  const fixture = createStorefrontProofData(routeId);
  if (!context) return fixture;
  const products = context.products.map(presentContextProduct);
  const catalogPage = products.slice(catalogOffset, catalogOffset + CATALOG_PAGE_SIZE);
  const nextCursor = catalogOffset + CATALOG_PAGE_SIZE < products.length
    ? String(catalogOffset + CATALOG_PAGE_SIZE)
    : null;
  const proofFeaturedProducts = routeId === "home" && featuredProductIds?.length
    ? featuredProductIds.slice(0, featuredProductLimit).flatMap((id) => {
        const product = products.find((entry) => entry.id === id);
        return product ? [product] : [];
      })
    : products.slice(0, featuredProductLimit);
  const active = products[0] ?? null;
  const emptyCart = products.length === 0 && fixture.cart ? {
    ...fixture.cart,
    count: 0,
    lines: [],
    subtotal: { cents: 0, currency: "USD" },
    discounts: { cents: 0, currency: "USD" },
    total: { cents: 0, currency: "USD" },
  } : fixture.cart;
  return {
    ...fixture,
    store: { name: context.store.name, logo: null },
    product: routeId === "product" ? active : null,
    featuredProducts: proofFeaturedProducts,
    relatedProducts: products.slice(1, 9),
    cart: emptyCart,
    collection: routeId === "collection" ? {
      ...(fixture.collection!),
      id: context.collections[0]?.id ?? "proof-collection",
      handle: context.collections[0]?.handle ?? "proof-collection",
      title: context.collections[0]?.title ?? "Catalog",
      productCount: context.collections[0]?.productCount ?? products.length,
      products: catalogPage,
      nextCursor,
    } : null,
    search: routeId === "search" ? {
      ...(fixture.search!),
      query: "studio",
      results: catalogPage,
      total: products.length,
      nextCursor,
    } : null,
  };
}

export function createStorefrontProofDataForBundle(
  routeId: StorefrontRouteId,
  bundle: StorefrontBundleV1,
  context?: MerchantStorefrontContext,
  catalogOffset = 0,
): PublicPresentationData {
  const featuredProductLimit = [...bundle.shell.requiredData, ...bundle.routes.home.requiredData]
    .find((requirement) => requirement.kind === "featuredProducts")?.limit ?? 12;
  return createStorefrontProofDataForContext(
    routeId,
    context,
    bundle.featuredProductIds,
    featuredProductLimit,
    catalogOffset,
  );
}

function checkoutSimulation() {
  return createElement(Fragment, null,
    createElement("label", null, "Email", createElement("input", { type: "email", name: "email", autoComplete: "email" })),
    createElement("button", { type: "button", "data-cd-proof-checkout": "continue" }, "Continue to payment"),
  );
}

function routeMarkup(
  bundle: StorefrontBundleV1,
  routeId: StorefrontRouteId,
  data: PublicPresentationData,
  mode: "public" | "preview",
  customAssetUrls?: Readonly<Record<string, string>>,
): string {
  return renderToStaticMarkup(renderStorefrontSurface({
    bundle,
    routeId,
    data,
    nonce: PROOF_NONCE,
    mode,
    visualLayerPlacement: resolveStorefrontVisualPlacement(bundle, routeId),
    customAssetUrls,
    checkoutContent: routeId === "checkout" ? checkoutSimulation() : undefined,
  }));
}

function normalizeParityMarkup(html: string): string {
  return html.replace(/href="[^"]*"/g, 'href="__ROUTE__"');
}

function documentHtml(markup: string, title: string, imageUrls: Iterable<string> = []): string {
  const imageOrigins = [...new Set([...imageUrls].flatMap((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:" ? [url.origin] : [];
    } catch {
      return [];
    }
  }))];
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${PROOF_NONCE}'`,
    `img-src 'self' data: ${imageOrigins.join(" ")}`,
    "font-src 'self'",
    "connect-src 'self'",
    `script-src 'nonce-${PROOF_NONCE}'`,
    "frame-src 'none'",
    "object-src 'none'",
    "worker-src 'none'",
    "form-action 'self'",
    "base-uri 'self'",
  ].join("; ");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><base href="${PROOF_ORIGIN}/"><link rel="icon" href="data:,"><title>${title.replace(/[<>&]/g, "")}</title><style nonce="${PROOF_NONCE}">html{background:#fff;color:#111}body{margin:0;min-height:100vh}:focus-visible{outline:3px solid #0b57d0!important;outline-offset:3px!important}[data-cd-trusted-slot]{display:block;min-width:44px;min-height:44px}</style></head><body>${markup}</body></html>`;
}

function browserRuntimeSource(): Promise<string> {
  proofRuntimeSource ??= build({
    entryPoints: [resolve(process.cwd(), "app/lib/storefront-validation/browser-runtime.client.ts")],
    absWorkingDir: process.cwd(),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["chrome120"],
    write: false,
    alias: { "~": resolve(process.cwd(), "app") },
  }).then((result) => result.outputFiles[0]?.text ?? Promise.reject(new Error("Storefront proof runtime bundle is empty")));
  return proofRuntimeSource;
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".woff2": "font/woff2",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

function proofSvg(pathname: string): string {
  const hue = Number.parseInt(createHash("sha256").update(pathname).digest("hex").slice(0, 4), 16) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900"><rect width="1200" height="900" fill="hsl(${hue} 35% 88%)"/><circle cx="860" cy="260" r="210" fill="hsl(${(hue + 55) % 360} 50% 58%)"/><path d="M120 710L430 240l270 470z" fill="hsl(${(hue + 180) % 360} 45% 38%)"/><text x="80" y="830" font-family="sans-serif" font-size="34" fill="#111">Northline proof catalog image</text></svg>`;
}

async function serveProofRequest(
  request: HTTPRequest,
  unexpected: string[],
  runtimeSource: string,
  ownedAssets: ReadonlyMap<string, { mediaType: string; bytes: Uint8Array }>,
  generatedImageUrls: ReadonlySet<string>,
  policies: ReadonlyMap<string, StorefrontPolicy>,
  storeName: string,
): Promise<void> {
  const url = request.url();
  if (url.startsWith("data:") || url === "about:blank") {
    await request.continue();
    return;
  }
  if (generatedImageUrls.has(url)) {
    await request.respond({ status: 200, contentType: "image/svg+xml", body: proofSvg(new URL(url).pathname) });
    return;
  }
  let parsed: URL;
  try { parsed = new URL(url); } catch {
    unexpected.push(url);
    await request.abort("blockedbyclient");
    return;
  }
  if (parsed.origin !== PROOF_ORIGIN) {
    unexpected.push(url);
    await request.abort("blockedbyclient");
    return;
  }
  if (parsed.pathname === "/__proof__/runtime.js") {
    await request.respond({ status: 200, contentType: "text/javascript; charset=utf-8", body: runtimeSource });
    return;
  }
  const policyId = resolveStorefrontPolicyPath(parsed.pathname);
  const policy = policyId ? policies.get(policyId) : undefined;
  if (policy) {
    const markup = renderToStaticMarkup(createElement(StorefrontPolicyPage, {
      policy,
      store: { name: storeName, logo: null },
    }));
    await request.respond({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: documentHtml(markup, `${policy.title} — ${storeName}`),
    });
    return;
  }
  const ownedAsset = ownedAssets.get(parsed.pathname);
  if (ownedAsset) {
    await request.respond({ status: 200, contentType: ownedAsset.mediaType, body: Buffer.from(ownedAsset.bytes) });
    return;
  }
  if (parsed.pathname.startsWith("/__proof__/")) {
    await request.respond({ status: 200, contentType: "image/svg+xml", body: proofSvg(parsed.pathname) });
    return;
  }
  const publicRoot = resolve(process.cwd(), "public");
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(parsed.pathname);
  } catch {
    unexpected.push(url);
    await request.respond({ status: 400, body: "Bad request" });
    return;
  }
  const filePath = resolve(publicRoot, `.${decodedPath}`);
  if (!filePath.startsWith(`${publicRoot}${sep}`)) {
    unexpected.push(url);
    await request.respond({ status: 403, body: "Forbidden" });
    return;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
    await request.respond({ status: 200, contentType: MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream", body: await readFile(filePath) });
  } catch {
    await request.respond({ status: 404, body: "Not found" });
  }
}

async function axeSource(): Promise<string> {
  return axeSourceText;
}

interface PageAuditResult {
  axe: Array<{ id: string; impact: string | null; help: string; nodes: Array<{ target: unknown; html: string; failureSummary?: string }> }>;
  imageFailures: string[];
  visibleImageUrls: string[];
  deadLinks: string[];
  unresolvedBindings: string[];
  inertControls: string[];
  protectedFailures: string[];
  commerceFailures: string[];
  checkoutFailures: string[];
  shellStyleFailures: string[];
  layoutFailures: string[];
  fullStoryFailures: string[];
  catalogProductHandles: string[];
  focusableCount: number;
  reducedMotion: boolean;
  cls: number;
  lcp: number;
  longTask: number;
}

export interface HorizontalLayoutAudit {
  documentWidth: number;
  viewportWidth: number;
  candidates: Array<{ label: string; left: number; right: number; contained: boolean }>;
}

export function detectHorizontalLayoutFailures(audit: HorizontalLayoutAudit): string[] {
  const failures: string[] = [];
  if (audit.documentWidth > audit.viewportWidth + 1) {
    failures.push(`document:${audit.documentWidth}px>${audit.viewportWidth}px`);
  }
  for (const candidate of audit.candidates) {
    if (candidate.contained) continue;
    if (candidate.left < -1 || candidate.right > audit.viewportWidth + 1) {
      failures.push(`${candidate.label}:${Math.round(candidate.left)}..${Math.round(candidate.right)}px`);
      if (failures.length >= 12) break;
    }
  }
  return failures;
}

async function auditPage(
  page: Page,
  bundle: StorefrontBundleV1,
  routeId: StorefrontRouteId,
  axe: string,
  expectedProductDescription: string | null,
  expectations: StorefrontProofExpectations["home"] | undefined,
  productIdsByHandle: ReadonlyMap<string, string>,
): Promise<PageAuditResult> {
  const route = routeId === "checkout" ? null : bundle.routes[routeId];
  const recipeSource = bundle.source.kind === "recipe" ? bundle.source : null;
  const fallbackAssetKey = recipeSource && isStoreTemplateId(recipeSource.templateId)
    ? getStoreTemplate(recipeSource.templateId).versions.find(
      ({ templateVersion }) => templateVersion === recipeSource.templateVersion,
    )?.visualLayer.fallbackAssetKey ?? null
    : null;
  const derivedVisualExpectation: "canvas" | "fallback" | null = routeId !== "home" || !fallbackAssetKey
    ? null
    : resolveStorefrontVisualPlacement(bundle, routeId) ? "canvas" : "fallback";
  const visualExpectation = routeId === "home"
    ? expectations?.visualLayer ?? derivedVisualExpectation
    : null;
  await page.evaluate(axe);
  const result = await page.evaluate(async ({ transitions, route, supportedRoutePattern, protectedFallbackKey }) => {
    const visible = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return !element.hidden && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const axeApi = (globalThis as unknown as { axe: { run(root: Document, options: unknown): Promise<{ violations: Array<{ id: string; impact: string | null; help: string; nodes: Array<{ target: unknown; html: string; failureSummary?: string }> }> }> } }).axe;
    const axeResult = await axeApi.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
      resultTypes: ["violations"],
    });
    const images = [...document.images];
    const imageFailures = images.flatMap((image) => {
      const source = image.currentSrc || image.getAttribute("src") || "";
      if (!source && image.hasAttribute("data-cd-bind-src")) return [`missing-src:${image.id || image.alt || "image"}`];
      return source && image.complete && image.naturalWidth === 0 ? [source] : [];
    });
    const visibleImageUrls = images
      .filter((image) => visible(image) && image.complete && image.naturalWidth > 0)
      .map((image) => image.currentSrc || image.src)
      .filter(Boolean);
    const allowed = new RegExp(supportedRoutePattern);
    const deadLinks = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")]
      .filter((link) => !link.closest("[data-cd-platform-content='policyLinks']"))
      .map((link) => link.getAttribute("href") ?? "")
      .filter((href) => href !== "#" && href.startsWith("/") && !allowed.test(href));
    const unresolvedBindings = [...document.querySelectorAll<HTMLElement>("[data-cd-text],[data-cd-money],[data-cd-src],[data-cd-alt],[data-cd-repeat]")]
      .map((element) => element.id || element.tagName.toLowerCase());
    const sources = new Set((transitions as Array<{ sourceId: string }>).map((entry) => entry.sourceId));
    const inertControls = [...document.querySelectorAll<HTMLElement>("button,input,select,textarea")]
      .filter((element) => visible(element) && !element.closest("[data-cd-trusted-slot]") && !element.closest("[data-cd-checkout-platform-root]"))
      .filter((element) => !sources.has(element.id.replace(/-i-[a-z0-9]+$/, "")))
      .map((element) => element.id || element.outerHTML.slice(0, 120));
    const protectedFailures = [...document.querySelectorAll<HTMLElement>("[data-cd-trusted-slot]")].flatMap((host) => {
      if (host.dataset.cdTrustedSlot === "cartDrawer" && host.hidden && !visible(host)) return [];
      host.scrollIntoView({ block: "center" });
      const rect = host.getBoundingClientRect();
      const x = Math.min(innerWidth - 1, Math.max(0, rect.left + Math.min(rect.width / 2, 20)));
      const y = Math.min(innerHeight - 1, Math.max(0, rect.top + Math.min(rect.height / 2, 20)));
      const hit = document.elementFromPoint(x, y);
      return visible(host) && hit && (hit === host || host.contains(hit)) ? [] : [host.id || host.dataset.cdTrustedSlot || "trusted-slot"];
    });
    const commerceFailures = [...document.querySelectorAll<HTMLElement>("[data-cd-trusted-slot]")].flatMap((host) => {
      if (host.dataset.cdTrustedSlot === "cartDrawer" && host.hidden && !visible(host)) return [];
      const controls = [...(host.shadowRoot?.querySelectorAll<HTMLElement>("button,input,select") ?? [])];
      if (!host.shadowRoot) return [`${host.id || host.dataset.cdTrustedSlot}:closed-or-missing-root`];
      if (controls.length === 0) return [`${host.id || host.dataset.cdTrustedSlot}:missing-control`];
      return controls.flatMap((control) => {
        const style = getComputedStyle(control);
        const rect = control.getBoundingClientRect();
        return visible(control) && rect.width >= 44 && rect.height >= 44 && style.backgroundColor !== "rgba(0, 0, 0, 0)"
          ? []
          : [`${host.id || host.dataset.cdTrustedSlot}:${control.tagName.toLowerCase()}:unstyled`];
      });
    });
    const checkoutFailures = route === "checkout"
      ? [
          document.querySelectorAll("[data-cd-checkout-section]").length === 6 ? "" : "missing-six-sections",
          document.querySelector("[data-cd-checkout-platform-root] button") ? "" : "missing-platform-checkout-control",
        ].filter(Boolean)
      : [];
    const shell = document.querySelector<HTMLElement>("[data-cd-bundle='shell']");
    const belongsToShell = (element: Element): boolean => element.closest("[data-cd-bundle]") === shell;
    const shellHeader = [...(shell?.querySelectorAll<HTMLElement>("header") ?? [])].find(belongsToShell);
    const shellNav = shellHeader?.querySelector<HTMLElement>("nav");
    const shellLink = shellNav?.querySelector<HTMLElement>("a[href]");
    const shellStyleFailures: string[] = [];
    if (!shell || !shellHeader || !shellNav || !shellLink) {
      shellStyleFailures.push("missing-shell-header-nav-link");
    } else {
      const navStyle = getComputedStyle(shellNav);
      const linkStyle = getComputedStyle(shellLink);
      const headerHeight = shellHeader.getBoundingClientRect().height;
      if (navStyle.display !== "flex" && navStyle.display !== "grid") {
        shellStyleFailures.push(`nav-display:${navStyle.display}`);
      }
      if (headerHeight < 44) shellStyleFailures.push(`header-height:${headerHeight.toFixed(1)}px`);
      if (linkStyle.color === "rgb(0, 0, 238)") shellStyleFailures.push("nav-link-default-blue");
      if (linkStyle.textDecorationLine !== "none") shellStyleFailures.push(`nav-link-decoration:${linkStyle.textDecorationLine}`);
    }
    for (const link of [...(shell?.querySelectorAll<HTMLAnchorElement>("a[href]") ?? [])].filter(belongsToShell)) {
      const style = getComputedStyle(link);
      const label = link.textContent?.trim().slice(0, 40) || link.id || "shell-link";
      if (style.color === "rgb(0, 0, 238)") shellStyleFailures.push(`link-default-blue:${label}`);
      if (style.textDecorationLine !== "none") shellStyleFailures.push(`link-decoration:${label}:${style.textDecorationLine}`);
    }
    const policyLinks = [...(shell?.querySelectorAll<HTMLAnchorElement>("[data-cd-platform-content='policyLinks'] a") ?? [])].filter(belongsToShell);
    const policyParents = new Set(policyLinks.map((link) => link.parentElement).filter((parent): parent is HTMLElement => Boolean(parent)));
    for (const parent of policyParents) {
      const display = getComputedStyle(parent).display;
      if (display !== "flex" && display !== "grid") shellStyleFailures.push(`policy-layout:${display}`);
    }
    const runtimeRoot = document.querySelector<HTMLElement>("[data-cd-bundle-runtime='1']");
    const viewportWidth = document.documentElement.clientWidth;
    const insideHorizontalScroller = (element: HTMLElement): boolean => {
      for (let parent = element.parentElement; parent && parent !== runtimeRoot; parent = parent.parentElement) {
        const overflow = getComputedStyle(parent).overflowX;
        if (overflow === "auto" || overflow === "scroll" || overflow === "hidden" || overflow === "clip") return true;
      }
      return false;
    };
    const layoutCandidates = [...(runtimeRoot?.querySelectorAll<HTMLElement>("*") ?? [])]
      .filter(visible)
      .slice(0, 2_000)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          label: element.id || element.tagName.toLowerCase(),
          left: rect.left,
          right: rect.right,
          contained: insideHorizontalScroller(element),
        };
      });
    const lightFocusable = [...document.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter(visible).length;
    const shadowFocusable = [...document.querySelectorAll<HTMLElement>("[data-cd-trusted-slot]")]
      .flatMap((host) => [...(host.shadowRoot?.querySelectorAll<HTMLElement>("button,input,select,textarea") ?? [])])
      .filter(visible).length;
    const focusableCount = lightFocusable + shadowFocusable;
    const protectedFallback = protectedFallbackKey
      ? [...document.querySelectorAll<HTMLElement>("[data-cd-asset-key]")]
        .find((element) => element.getAttribute("data-cd-asset-key") === protectedFallbackKey)
      : null;
    const visualCanvas = document.querySelector<HTMLElement>("[data-cd-visual-host] canvas");
    const sourceText = (element: Element): string => {
      const parts: string[] = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const value = walker.currentNode.textContent?.trim();
        if (value) parts.push(value);
      }
      return parts.join(" ");
    };
    const routeRoot = document.querySelector<HTMLElement>(`[data-cd-bundle-route='${route}']`);
    const catalogProductHandles = [...(routeRoot?.querySelectorAll<HTMLElement>("[data-cd-repeat-owner='true']") ?? [])]
      .flatMap((owner) => {
        const links = owner.matches("a[href]")
          ? [owner as HTMLAnchorElement]
          : [...owner.querySelectorAll<HTMLAnchorElement>("a[href]")];
        const match = links.map((link) => new URL(link.href).pathname.match(/^\/storefront\/products\/([^/]+)$/))
          .find((candidate) => candidate);
        return match?.[1] ? [decodeURIComponent(match[1])] : [];
      });
    const shifts = performance.getEntriesByType("layout-shift") as Array<PerformanceEntry & { value?: number; hadRecentInput?: boolean }>;
    const paints = performance.getEntriesByType("largest-contentful-paint") as Array<PerformanceEntry & { startTime: number }>;
    const tasks = performance.getEntriesByType("longtask") as Array<PerformanceEntry & { duration: number }>;
    return {
      axe: axeResult.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious").map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        nodes: violation.nodes.slice(0, 8).map((node) => ({ target: node.target, html: node.html, ...(node.failureSummary ? { failureSummary: node.failureSummary } : {}) })),
      })),
      imageFailures,
      visibleImageUrls,
      deadLinks,
      unresolvedBindings,
      inertControls,
      protectedFailures,
      commerceFailures,
      checkoutFailures,
      shellStyleFailures,
      layout: { documentWidth: document.documentElement.scrollWidth, viewportWidth, candidates: layoutCandidates },
      focusableCount,
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      cls: shifts.filter((entry) => !entry.hadRecentInput).reduce((sum, entry) => sum + (entry.value ?? 0), 0),
      lcp: paints.at(-1)?.startTime ?? 0,
      longTask: Math.max(0, ...tasks.map((entry) => entry.duration)),
      fullStory: {
        renderedText: document.body.innerText,
        renderedHeroTexts: [...document.querySelectorAll<HTMLElement>("h1")].filter(visible).map(sourceText),
        hasVisualCanvas: Boolean(visualCanvas && visible(visualCanvas)),
        hasProtectedFallback: Boolean(protectedFallback && visible(protectedFallback)),
      },
      catalogProductHandles,
    };
  }, {
    transitions: route?.interactions.transitions ?? [],
    route: routeId,
    supportedRoutePattern: STOREFRONT_PROOF_ROUTE_RE.source,
    protectedFallbackKey: fallbackAssetKey,
  });
  const { layout, fullStory, ...audit } = result;
  return {
    ...audit,
    layoutFailures: detectHorizontalLayoutFailures(layout),
    fullStoryFailures: detectFullStoryFailures({
      routeId,
      expectedProductDescription,
      expectedHeroText: expectations?.heroText,
      expectedFeaturedProductIds: expectations?.featuredProductIds,
      visualExpectation,
      renderedFeaturedProductIds: [...new Set(result.catalogProductHandles.map(
        (handle) => productIdsByHandle.get(handle) ?? `unknown:${handle}`,
      ))],
      ...fullStory,
    }),
  };
}

async function pixelDiffRatio(page: Page, current: Buffer, baseline: Buffer, channelTolerance = 8): Promise<number> {
  return page.evaluate(async ({ currentUrl, baselineUrl, tolerance }) => {
    const pixels = async (url: string) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      context.drawImage(image, 0, 0);
      return { width: canvas.width, height: canvas.height, data: context.getImageData(0, 0, canvas.width, canvas.height).data };
    };
    const [left, right] = await Promise.all([pixels(currentUrl), pixels(baselineUrl)]);
    if (left.width !== right.width || left.height !== right.height) return 1;
    let changed = 0;
    for (let index = 0; index < left.data.length; index += 4) {
      if (Math.abs(left.data[index] - right.data[index]) > tolerance ||
          Math.abs(left.data[index + 1] - right.data[index + 1]) > tolerance ||
          Math.abs(left.data[index + 2] - right.data[index + 2]) > tolerance ||
          Math.abs(left.data[index + 3] - right.data[index + 3]) > tolerance) changed += 1;
    }
    return changed / (left.width * left.height);
  }, {
    currentUrl: `data:image/webp;base64,${current.toString("base64")}`,
    baselineUrl: `data:image/webp;base64,${baseline.toString("base64")}`,
    tolerance: channelTolerance,
  });
}

function addDiagnostic(
  list: StorefrontBrowserDiagnostic[],
  routeId: StorefrontRouteId,
  viewport: StorefrontProofViewportName,
  code: string,
  message: string,
  detail?: Record<string, unknown>,
): void {
  list.push({ routeId, viewport, code, message, severity: "serious", ...(detail ? { detail } : {}) });
}

export async function proveStorefrontBundle(input: ProveStorefrontBundleInput): Promise<ProveStorefrontBundleResult> {
  const startedAt = Date.now();
  const timeoutMs = Math.max(1, input.timeoutMs ?? 60_000);
  const deadlineAt = startedAt + timeoutMs;
  const assertActive = (): void => {
    if (input.signal?.aborted) throw input.signal.reason ?? new DOMException("Browser proof cancelled", "AbortError");
    if (Date.now() >= deadlineAt) throw new DOMException(`Browser proof exceeded its ${timeoutMs}ms deadline`, "TimeoutError");
  };
  const diagnostics = [...validateStorefrontBundleBudgets(input.bundle).diagnostics];
  const ownedAssets = new Map<string, { mediaType: string; bytes: Uint8Array }>();
  const customAssetUrls: Record<string, string> = {};
  if (input.bundle.source.kind === "custom") {
    const provided = new Map((input.persistedAssets ?? []).map((asset) => [asset.logicalKey, asset]));
    for (const entry of input.bundle.assets.entries) {
      const asset = provided.get(entry.key);
      if (!asset) {
        const derivedTemplateId = input.bundle.source.derivedFromTemplateId;
        if (derivedTemplateId && entry.mediaType === "image/webp") {
          try {
            const publicBytes = await readFile(resolve(process.cwd(), `public/storefront-recipes/${derivedTemplateId}/${entry.key}.webp`));
            if (publicBytes.byteLength === entry.byteSize && createHash("sha256").update(publicBytes).digest("hex") === entry.contentHash) {
              customAssetUrls[entry.key] = `/storefront-recipes/${derivedTemplateId}/${entry.key}.webp`;
              continue;
            }
          } catch {
            // Fall through to the fail-closed persisted-asset diagnostic.
          }
        }
        addDiagnostic(diagnostics, "home", "desktop", "asset.persisted-missing", `Custom asset ${entry.key} has no verified persisted proof bytes`);
        continue;
      }
      const bytes = asset.bytes instanceof Uint8Array ? asset.bytes : new Uint8Array();
      const contentHash = createHash("sha256").update(bytes).digest("hex");
      if (asset.key !== entry.key || asset.mediaType !== entry.mediaType || asset.byteSize !== bytes.byteLength ||
          asset.contentHash !== entry.contentHash || contentHash !== entry.contentHash) {
        addDiagnostic(diagnostics, "home", "desktop", "asset.persisted-mismatch", `Custom asset ${entry.key} failed immutable manifest verification`);
        continue;
      }
      const pathname = `/__proof__/owned-assets/${encodeURIComponent(entry.key)}`;
      ownedAssets.set(pathname, { mediaType: entry.mediaType, bytes });
      customAssetUrls[entry.key] = `${PROOF_ORIGIN}${pathname}`;
    }
  }
  const screenshots: string[] = [];
  const screenshotManifest: ProveStorefrontBundleResult["screenshotManifest"] = [];
  const expectedGeneratedImageUrls = new Set(input.expectations?.generatedImageUrls ?? []);
  const visibleGeneratedImageUrls = new Set<string>();
  const metrics = measureStorefrontBundle(input.bundle);
  const proofCases = buildStorefrontProofCases(input.bundle, input.routes, {
    catalogProductCount: input.catalogPagination ? input.context?.products.length : undefined,
    viewports: input.viewports,
  });
  const proofCatalog = input.context
    ? input.catalog ?? createStorefrontProofCatalog(input.context)
    : null;
  const catalogPages = input.catalogPagination && input.context && proofCatalog
    ? {
        collection: proofCases.some(({ routeId }) => routeId === "collection")
          ? await resolveStorefrontProofCatalogPages("collection", input.context, proofCatalog)
          : [],
        search: proofCases.some(({ routeId }) => routeId === "search")
          ? await resolveStorefrontProofCatalogPages("search", input.context, proofCatalog)
          : [],
      }
    : null;
  type CatalogPageEvidence = {
    catalogOffset: number;
    viewport: StorefrontProofViewportName;
    productIds: string[];
  };
  const provedCatalogPages: Record<"collection" | "search", CatalogPageEvidence[]> = {
    collection: [],
    search: [],
  };
  const productIdsByHandle = new Map(input.context?.products.map(({ id, handle }) => [handle, id]) ?? []);
  const ownBrowser = !input.browser;
  const browser = input.browser ?? await launchChromium();
  const page = await browser.newPage();
  page.setDefaultTimeout(Math.min(30_000, timeoutMs));
  page.setDefaultNavigationTimeout(Math.min(60_000, timeoutMs));
  const unexpectedRequests: string[] = [];
  const consoleErrors: string[] = [];
  const requestFailures: string[] = [];
  const axe = await axeSource();
  const runtimeSource = await browserRuntimeSource();
  const proofPolicies = new Map(storefrontProofPolicies().map((policy) => [policy.id, policy]));
  const proofStoreName = input.context?.store.name ?? createStorefrontProofData("home").store.name;
  let currentUnexpected: string[] = [];
  let currentConsole: string[] = [];
  let currentFailures: string[] = [];
  let currentDocument = "";
  page.on("request", (request) => {
    const parsed = new URL(request.url());
    if (parsed.origin === PROOF_ORIGIN && parsed.pathname === "/__proof__/document") {
      void request.respond({ status: 200, contentType: "text/html; charset=utf-8", body: currentDocument });
      return;
    }
    void serveProofRequest(
      request,
      currentUnexpected,
      runtimeSource,
      ownedAssets,
      expectedGeneratedImageUrls,
      proofPolicies,
      proofStoreName,
    );
  });
  page.on("console", (message) => {
    if (message.type() === "error") currentConsole.push(message.text());
  });
  page.on("pageerror", (error) => currentConsole.push(error instanceof Error ? error.message : String(error)));
  page.on("requestfailed", (request) => currentFailures.push(`${request.url()}: ${request.failure()?.errorText ?? "failed"}`));
  await page.setRequestInterception(true);
  try {
    for (const [caseIndex, proofCase] of proofCases.entries()) {
      assertActive();
      const caseDiagnosticStart = diagnostics.length;
      const { routeId, viewport, catalogOffset } = proofCase;
      currentUnexpected = [];
      currentConsole = [];
      currentFailures = [];
      const productionPage = routeId === "collection" || routeId === "search"
        ? catalogPages?.[routeId][Math.floor(catalogOffset / CATALOG_PAGE_SIZE)]
        : undefined;
      const data = productionPage
        ?? createStorefrontProofDataForBundle(routeId, input.bundle, input.context, catalogOffset);
      let publicMarkup: string;
      let previewMarkup: string;
      try {
        publicMarkup = routeMarkup(input.bundle, routeId, data, "public", customAssetUrls);
        previewMarkup = routeMarkup(input.bundle, routeId, data, "preview", customAssetUrls);
      } catch (error) {
        addDiagnostic(diagnostics, routeId, viewport.name, "render.exception", error instanceof Error ? error.message : String(error));
        continue;
      }
      if (normalizeParityMarkup(publicMarkup) !== normalizeParityMarkup(previewMarkup)) {
        addDiagnostic(diagnostics, routeId, viewport.name, "preview-public.parity", "Preview and public render trees differ outside platform-owned route destinations");
      }
      await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1 });
      await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
      currentDocument = documentHtml(
        publicMarkup,
        `${input.bundle.concept.name} — ${routeId}`,
        expectedGeneratedImageUrls,
      );
      await page.goto(`${PROOF_ORIGIN}/__proof__/document?route=${routeId}&viewport=${viewport.name}&cursor=${catalogOffset}`, {
        waitUntil: "load",
        timeout: Math.max(1, Math.min(60_000, deadlineAt - Date.now())),
      });
      await page.evaluate(async () => {
        if (document.fonts?.ready) await document.fonts.ready;
        scrollTo(0, document.body.scrollHeight);
        await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
        scrollTo(0, 0);
      });
      await page.evaluate(async ({ proofNonce, proofOrigin, proofBundle, proofRouteId, proofData }) => {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function proofOpenShadow(init: ShadowRootInit): ShadowRoot {
          return originalAttachShadow.call(this, { ...init, mode: "open" });
        };
        const script = document.createElement("script");
        script.nonce = proofNonce;
        script.src = `${proofOrigin}/__proof__/runtime.js`;
        const loaded = new Promise<void>((resolveLoaded, rejectLoaded) => {
          script.addEventListener("load", () => resolveLoaded(), { once: true });
          script.addEventListener("error", () => rejectLoaded(new Error("Storefront proof runtime failed to load")), { once: true });
        });
        document.head.append(script);
        await loaded;
        const hydrate = (window as typeof window & {
          __CD_HYDRATE_STOREFRONT_PROOF__?: (input: {
            bundle: StorefrontBundleV1;
            routeId: StorefrontRouteId;
            data: PublicPresentationData;
          }) => { shellHydrated: boolean; routeHydrated: boolean };
        }).__CD_HYDRATE_STOREFRONT_PROOF__;
        if (!hydrate) throw new Error("Storefront proof hydrator is unavailable");
        const result = hydrate({ bundle: proofBundle, routeId: proofRouteId, data: proofData });
        if (!result.shellHydrated || !result.routeHydrated) throw new Error("Storefront proof hydration did not complete");
        await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
      }, {
        proofNonce: PROOF_NONCE,
        proofOrigin: PROOF_ORIGIN,
        proofBundle: input.bundle,
        proofRouteId: routeId,
        proofData: data,
      });
      assertActive();
      let previewImage: Buffer | undefined;
      if (shouldVerifyStorefrontPreview(routeId, viewport.name, input.artifacts)) {
        await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
        await page.evaluate(() => new Promise((resolveFrame) =>
          requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
        previewImage = Buffer.from(await page.screenshot({ type: "webp", quality: 90, fullPage: false }));
        if (!shouldWriteStorefrontPreview(routeId, viewport.name, input.artifacts)) {
          try {
            const diff = await pixelDiffRatio(page, previewImage, await readFile(input.artifacts!.previewFile!), 0);
            if (diff > 0) addDiagnostic(
              diagnostics,
              routeId,
              viewport.name,
              "visual.preview-regression",
              `Template preview differs across ${(diff * 100).toFixed(3)}% of pixels`,
              { preview: input.artifacts!.previewFile!, ratio: diff },
            );
          } catch (error) {
            addDiagnostic(
              diagnostics,
              routeId,
              viewport.name,
              "visual.preview-missing",
              error instanceof Error ? error.message : String(error),
              { preview: input.artifacts!.previewFile! },
            );
          }
        }
        await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1 });
        await page.evaluate(() => new Promise((resolveFrame) =>
          requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
      }
      const image = Buffer.from(await page.screenshot({ type: "webp", quality: 90, fullPage: false }));
      const commerceExerciseFailures = await page.evaluate(async (activeRoute) => {
        const failures: string[] = [];
        if (activeRoute === "checkout") {
          const email = document.querySelector<HTMLInputElement>("input[name='email']");
          if (email) email.value = "buyer@example.test";
        }
        for (const host of document.querySelectorAll<HTMLElement>("[data-cd-trusted-slot]")) {
          if (host.dataset.cdTrustedSlot === "cartDrawer" && host.hidden) continue;
          const controls = [...(host.shadowRoot?.querySelectorAll<HTMLElement>("button,select,input") ?? [])];
          if (controls.length === 0) {
            failures.push(`${host.id || host.dataset.cdTrustedSlot}:missing-control`);
            continue;
          }
          for (const control of controls) {
            if (control.matches(":disabled")) continue;
            if (control instanceof HTMLInputElement) {
              control.dataset.cdProofInitialValue = control.value;
              if (control.type === "number") control.value = String(Number(control.value) + 1);
              control.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
            } else if (control instanceof HTMLSelectElement) {
              control.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
            } else {
              control.click();
            }
          }
        }
        if (activeRoute === "checkout") {
          document.querySelector<HTMLButtonElement>("[data-cd-proof-checkout='continue']")?.click();
        }
        await new Promise((resolveTick) => setTimeout(resolveTick, 0));
        return failures;
      }, routeId);
      const buyerFlowEvidence = await page.evaluate(() => {
        let requests: StorefrontBuyerFlowRequest[] = [];
        try {
          const parsed = JSON.parse(document.documentElement.dataset.cdProofRequests ?? "[]") as unknown;
          if (Array.isArray(parsed)) requests = parsed as StorefrontBuyerFlowRequest[];
        } catch {
          requests = [];
        }
        return {
          requests,
          navigation: document.documentElement.dataset.cdProofNavigation ?? null,
          refreshCount: Number(document.documentElement.dataset.cdProofRefreshCount ?? 0),
          initialCartCount: Number(document.documentElement.dataset.cdProofInitialCartCount ?? 0),
          finalCartCount: Number(document.documentElement.dataset.cdProofCartCount ?? 0),
        };
      });
      const expectedVariantId = data.product?.variants.find((variant) => variant.available)?.id;
      const firstCartLine = data.cart?.lines[0];
      const buyerFlowFailures = detectBuyerFlowFailures({
        routeId,
        ...buyerFlowEvidence,
        ...(expectedVariantId ? { expectedVariantId } : {}),
        ...(firstCartLine ? { expectedCartLine: { id: firstCartLine.id, quantity: firstCartLine.quantity } } : {}),
      });
      await page.evaluate(() => {
        for (const host of document.querySelectorAll<HTMLElement>("[data-cd-trusted-slot]")) {
          for (const input of host.shadowRoot?.querySelectorAll<HTMLInputElement>("input[data-cd-proof-initial-value]") ?? []) {
            input.value = input.dataset.cdProofInitialValue ?? input.value;
            delete input.dataset.cdProofInitialValue;
          }
        }
        const checkoutEmail = document.querySelector<HTMLInputElement>("input[name='email']");
        if (checkoutEmail) checkoutEmail.value = "";
      });
      const consoleBeforeAxe = [...currentConsole];
      const audit = await auditPage(
        page,
        input.bundle,
        routeId,
        axe,
        data.product?.description ?? null,
        routeId === "home" ? input.expectations?.home : undefined,
        productIdsByHandle,
      );
      for (const url of audit.visibleImageUrls) {
        if (expectedGeneratedImageUrls.has(url)) visibleGeneratedImageUrls.add(url);
      }
      assertActive();
      const policyRouteFailures = await verifyStorefrontPolicyRoutes(
        await page.$$eval("[data-cd-platform-content='policyLinks'] a[href]", (links) => links.map((link) => {
          const anchor = link as HTMLAnchorElement;
          return {
            id: new URL(anchor.href).pathname.split("/").at(-1) ?? "",
            href: anchor.getAttribute("href") ?? "",
          };
        })),
        (href) => page.evaluate(async (policyHref) => {
          const response = await fetch(policyHref, { credentials: "omit", redirect: "manual" });
          const contentType = response.headers.get("content-type") ?? "";
          const html = await response.text();
          const policyDocument = new DOMParser().parseFromString(html, "text/html");
          return {
            status: response.status,
            contentType,
            policyId: policyDocument.querySelector<HTMLElement>("[data-cd-storefront-policy]")?.dataset.cdStorefrontPolicy ?? null,
          };
        }, href),
      );
      assertActive();
      // axe temporarily applies inline styles while computing contrast. Those
      // sandbox mutations are not storefront CSP violations and are discarded;
      // navigation/resource/runtime console errors captured before axe remain.
      currentConsole = consoleBeforeAxe;
      if (audit.axe.length) addDiagnostic(diagnostics, routeId, viewport.name, "axe.serious", `${audit.axe.length} serious or critical axe violation groups`, { violations: audit.axe });
      if (audit.imageFailures.length) addDiagnostic(diagnostics, routeId, viewport.name, "asset.failed", "Required images failed to load", { assets: audit.imageFailures });
      if (audit.deadLinks.length) addDiagnostic(diagnostics, routeId, viewport.name, "link.dead", "Internal links escaped the supported storefront route matrix", { links: audit.deadLinks });
      if (audit.unresolvedBindings.length) addDiagnostic(diagnostics, routeId, viewport.name, "binding.unresolved", "Compiler binding attributes survived into the rendered DOM", { nodes: audit.unresolvedBindings });
      if (audit.inertControls.length) addDiagnostic(diagnostics, routeId, viewport.name, "control.inert", "Visible controls lack a compiled action", { controls: audit.inertControls });
      if (audit.protectedFailures.length) addDiagnostic(diagnostics, routeId, viewport.name, "hit-test.protected", "Protected commerce hosts are not visible and hit-testable", { hosts: audit.protectedFailures });
      if (commerceExerciseFailures.length || audit.commerceFailures.length) addDiagnostic(diagnostics, routeId, viewport.name, "commerce.runtime", "Trusted commerce controls did not hydrate, style, or execute", { failures: [...commerceExerciseFailures, ...audit.commerceFailures] });
      if (buyerFlowFailures.length) addDiagnostic(diagnostics, routeId, viewport.name, "buyer.path", "Cart mutation and checkout navigation did not complete", { failures: buyerFlowFailures });
      if (audit.checkoutFailures.length) addDiagnostic(diagnostics, routeId, viewport.name, "checkout.boundary", "Checkout platform boundary is incomplete", { failures: audit.checkoutFailures });
      if (audit.shellStyleFailures.length) addDiagnostic(diagnostics, routeId, viewport.name, "shell.unstyled", "Storefront shell retains raw browser navigation styling", { failures: audit.shellStyleFailures });
      if (audit.layoutFailures.length) addDiagnostic(diagnostics, routeId, viewport.name, "layout.overflow", "Storefront content escapes the viewport", { failures: audit.layoutFailures });
      if (audit.fullStoryFailures.length) addDiagnostic(
        diagnostics,
        routeId,
        viewport.name,
        "story.incomplete",
        "Storefront rendering did not satisfy the expected content or visual outcome",
        {
          failures: audit.fullStoryFailures,
          ...(routeId === "home" && input.expectations?.home ? { expectations: input.expectations.home } : {}),
        },
      );
      if (policyRouteFailures.length) addDiagnostic(diagnostics, routeId, viewport.name, "policy.route", "Merchant policy links do not resolve to matching same-origin storefront policy pages", { failures: policyRouteFailures });
      if (audit.focusableCount === 0) addDiagnostic(diagnostics, routeId, viewport.name, "keyboard.empty", "Route has no keyboard-focusable navigation or commerce control");
      if (!audit.reducedMotion) addDiagnostic(diagnostics, routeId, viewport.name, "motion.preference", "Reduced-motion media preference was not active");
      if (audit.cls >= 0.1) addDiagnostic(diagnostics, routeId, viewport.name, "performance.cls", `CLS ${audit.cls.toFixed(3)} exceeds 0.10`);
      if (audit.lcp >= 2_500) addDiagnostic(diagnostics, routeId, viewport.name, "performance.lcp", `LCP ${Math.round(audit.lcp)}ms exceeds 2500ms`);
      if (audit.longTask > 50) addDiagnostic(diagnostics, routeId, viewport.name, "performance.long-task", `Long task ${Math.round(audit.longTask)}ms exceeds 50ms`);
      metrics.maxCumulativeLayoutShift = Math.max(metrics.maxCumulativeLayoutShift ?? 0, audit.cls);
      metrics.maxLargestContentfulPaintMs = Math.max(metrics.maxLargestContentfulPaintMs ?? 0, audit.lcp);
      metrics.maxLongTaskMs = Math.max(metrics.maxLongTaskMs ?? 0, audit.longTask);
      if (currentUnexpected.length) addDiagnostic(diagnostics, routeId, viewport.name, "network.unexpected", "Unexpected external requests were blocked", { requests: currentUnexpected });
      if (currentFailures.length) addDiagnostic(diagnostics, routeId, viewport.name, "network.failed", "Required storefront requests failed", { requests: currentFailures });
      if (currentConsole.length) addDiagnostic(diagnostics, routeId, viewport.name, "console.error", "Browser emitted uncaught errors", { errors: currentConsole });
      unexpectedRequests.push(...currentUnexpected);
      requestFailures.push(...currentFailures);
      consoleErrors.push(...currentConsole);

      assertActive();
      const sha256 = createHash("sha256").update(image).digest("hex");
      const screenshotRef = `sha256:${sha256}`;
      screenshots.push(screenshotRef);
      const manifestEntry: ProveStorefrontBundleResult["screenshotManifest"][number] = {
        routeId,
        viewport: viewport.name,
        sha256,
        ...((routeId === "collection" || routeId === "search") ? { catalogOffset } : {}),
      };
      if (input.artifacts?.baselineDirectory) {
        const baselineVersion = input.bundle.source.kind === "recipe" ? input.bundle.source.templateVersion : 1;
        const routeSuffix = routeId === "home" ? "" : `-${routeId}`;
        const pageSuffix = catalogOffset > 0 ? `-${catalogOffset}` : "";
        const baseline = resolve(
          input.artifacts.baselineDirectory,
          `v${baselineVersion}${routeSuffix}${pageSuffix}-${viewport.name}.webp`,
        );
        manifestEntry.baseline = baseline;
        await mkdir(input.artifacts.baselineDirectory, { recursive: true });
        if (input.artifacts.updateBaselines) {
          if (diagnostics.length > caseDiagnosticStart) {
            throw new Error(`Refusing to capture a failing storefront case: ${routeId}@${viewport.name}`);
          }
          await writeFile(baseline, image, { flag: "wx" });
          if (previewImage && input.artifacts.previewFile) {
            await mkdir(resolve(input.artifacts.previewFile, ".."), { recursive: true });
            await writeFile(input.artifacts.previewFile, previewImage);
          }
        }
        else {
          try {
            const diff = await pixelDiffRatio(page, image, await readFile(baseline));
            manifestEntry.pixelDiffRatio = diff;
            if (diff > 0.005) addDiagnostic(diagnostics, routeId, viewport.name, "visual.regression", `Pixel difference ${(diff * 100).toFixed(3)}% exceeds 0.5%`, { baseline, ratio: diff });
          } catch (error) {
            addDiagnostic(diagnostics, routeId, viewport.name, "visual.baseline-missing", error instanceof Error ? error.message : String(error), { baseline });
          }
        }
      }
      screenshotManifest.push(manifestEntry);

      // Commerce exercise intentionally clicks every trusted control. Reset
      // that synthetic pointer focus before proving keyboard entry; otherwise
      // Tab can start at the final shadow control, wrap to <body>, and report a
      // route-dependent false failure when merchant product counts change.
      await page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        const nested = active?.shadowRoot?.activeElement;
        if (nested instanceof HTMLElement) nested.blur();
        active?.blur();
        scrollTo(0, 0);
        document.body.setAttribute("tabindex", "-1");
        document.body.focus({ preventScroll: true });
        document.body.removeAttribute("tabindex");
      });
      await page.keyboard.press("Tab");
      const focus = await page.evaluate(({ expectedWidth, expectedHeight }) => {
        const viewportMatches = innerWidth === expectedWidth && innerHeight === expectedHeight;
        let active = document.activeElement as HTMLElement | null;
        if (active?.shadowRoot?.activeElement instanceof HTMLElement) active = active.shadowRoot.activeElement;
        if (!active || active === document.body) return { ok: false, outline: false, viewportMatches };
        const style = getComputedStyle(active);
        return { ok: true, outline: style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0, viewportMatches };
      }, { expectedWidth: viewport.width, expectedHeight: viewport.height });
      if (!focus.viewportMatches) addDiagnostic(diagnostics, routeId, viewport.name, "proof.viewport", "Keyboard proof ran at the wrong viewport");
      if (!focus.ok) addDiagnostic(diagnostics, routeId, viewport.name, "keyboard.focus", "Tab did not move focus to an interactive control");
      else if (!focus.outline) addDiagnostic(diagnostics, routeId, viewport.name, "focus.visible", "Keyboard focus has no visible outline");
      if (input.catalogPagination && (routeId === "collection" || routeId === "search")) {
        provedCatalogPages[routeId].push({
          catalogOffset,
          viewport: viewport.name,
          productIds: audit.catalogProductHandles.map((handle) => productIdsByHandle.get(handle) ?? `unknown:${handle}`),
        });
      }
      input.onProgress?.({ routeId, viewport: viewport.name, completed: caseIndex + 1, total: proofCases.length });
    }
    if (input.catalogPagination && input.context) {
      const expectedIds = input.context.products.map(({ id }) => id);
      for (const routeId of ["collection", "search"] as const) {
        for (const viewport of [...new Set(provedCatalogPages[routeId].map((page) => page.viewport))]) {
          const observedPages = provedCatalogPages[routeId]
            .filter((page) => page.viewport === viewport)
            .sort((left, right) => left.catalogOffset - right.catalogOffset)
            .map((page) => page.productIds);
          const failure = detectCatalogPaginationFailure(expectedIds, observedPages);
          if (failure) {
            addDiagnostic(
              diagnostics,
              routeId,
              viewport,
              failure.code,
              "Cursor pages did not render every merchant product exactly once",
              failure.detail,
            );
          }
        }
      }
    }
    if (expectedGeneratedImageUrls.size > 0
      && visibleGeneratedImageUrls.size !== expectedGeneratedImageUrls.size) {
      const proofCase = proofCases.find(({ routeId }) => routeId === "collection") ?? proofCases[0];
      addDiagnostic(
        diagnostics,
        proofCase?.routeId ?? "home",
        proofCase?.viewport.name ?? "desktop",
        "story.generated-images",
        "Generated catalog images did not become browser-visible",
        { expected: expectedGeneratedImageUrls.size, visible: visibleGeneratedImageUrls.size },
      );
    }
  } finally {
    await page.close();
    if (ownBrowser) await browser.close();
  }
  const report = createBrowserProofReport({
    diagnostics,
    screenshots,
    browserMs: Date.now() - startedAt,
    metrics,
    cases: proofCases.length,
  });
  return { ...report, screenshotManifest };
}

/** Production adapter shape consumed by the AI storefront compiler. */
export async function storefrontAiBrowserProof(input: {
  bundle: StorefrontBundleV1;
  context?: MerchantStorefrontContext;
  persistedAssets?: MaterializedAssetResult["proofAssets"];
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<BrowserProofReport> {
  return proveStorefrontBundle(input);
}
