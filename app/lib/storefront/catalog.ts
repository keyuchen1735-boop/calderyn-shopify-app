// app/lib/storefront/catalog.ts
// The shared catalog read contract. John implements this verbatim against the
// owned catalog later (master spec §#5); the fixture stub implements it now.
// shopId is the first argument of every method — every implementation MUST scope
// its reads to that shopId (the contract-level defense against cross-tenant leakage
// on this public, unauthenticated surface; there is no Postgres RLS).
export const MAX_PUBLIC_PRODUCT_PAGE_SIZE = 24;
export const MAX_STOREFRONT_CARD_DESCRIPTION_CODE_POINTS = 500;
export const MISSING_PRICE_ASC_SORT_VALUE = Number.MAX_SAFE_INTEGER;
// retail_price_cents is an integer, so this stays below every persisted price.
export const MISSING_PRICE_DESC_SORT_VALUE = -2147483649;

export function capStorefrontCardDescription(value: string): string {
  return [...value].slice(0, MAX_STOREFRONT_CARD_DESCRIPTION_CODE_POINTS).join("");
}

export type StorefrontCatalogSearchSort =
  | "relevance"
  | "title_asc"
  | "title_desc"
  | "price_asc"
  | "price_desc";

export interface StorefrontCatalogSearchOptions {
  query: string;
  collection: string | null;
  category: string | null;
  tag: string | null;
  available: boolean | null;
  sort: StorefrontCatalogSearchSort;
  limit: number;
  after: { sortValue: string | number; productId: string } | null;
}

export interface StorefrontCatalogSearchPage {
  items: StoreProduct[];
  boundary?: { sortValue: string | number; productId: string } | null;
  facets: {
    categories: Array<{ value: string; count: number }>;
    tags: Array<{ value: string; count: number }>;
    collections: Array<{ value: string; count: number }>;
  };
  total: number;
  hasNextPage: boolean;
}

export function encodeProductPageCursor(title: string, id: string): string {
  return JSON.stringify([title, id]);
}

export function decodeProductPageCursor(cursor: string): { title: string; id: string } {
  try {
    const value: unknown = JSON.parse(cursor);
    if (!Array.isArray(value) || value.length !== 2 ||
        typeof value[0] !== "string" || typeof value[1] !== "string") throw new Error();
    return { title: value[0], id: value[1] };
  } catch {
    throw new Error("invalid storefront product cursor");
  }
}

export interface StorefrontCatalog {
  searchProductPage(
    shopId: string,
    opts: StorefrontCatalogSearchOptions,
  ): Promise<StorefrontCatalogSearchPage>;
  listProductPage(
    shopId: string,
    opts: { collection?: string; query?: string; cursor?: string | null; limit: number },
  ): Promise<{ items: StoreProduct[]; nextCursor: string | null }>;
  /** opts.ids restricts to explicit product ids (curated grids) — implementations must
   *  scope the id read to the shop and skip the full-catalog fetch. */
  listProducts(shopId: string, opts?: { collection?: string; ids?: string[]; limit?: number; query?: string }): Promise<StoreProduct[]>;
  getProduct(shopId: string, handle: string): Promise<StoreProduct | null>;
  /** Direct commerce lookup that is not constrained by the presentation catalog cap. */
  getVariantById?(
    shopId: string,
    variantId: string,
  ): Promise<{ product: StoreProduct; variant: StoreVariant } | null>;
  getCollection?(shopId: string, handle: string): Promise<StoreCollection | null>;
  listCollections(shopId: string): Promise<StoreCollection[]>;
}

export interface StoreProduct {
  id: string;
  handle: string;
  title: string;
  description: string;
  images: { url: string; alt: string | null }[];
  variants: StoreVariant[];
  options?: Array<{ name: string; values: string[] }>;
  collections: string[]; // collection handles
  category?: string | null;
  tags?: string[];
}

export interface StoreVariant {
  id: string;
  sku: string | null;
  title: string;
  priceCents: number;
  /** Struck-through "was" price in cents; render only when > priceCents.
   *  Optional so fixture/legacy variant literals stay valid. */
  compareAtPriceCents?: number | null;
  currency: string;
  available: boolean;
  /** False only when the source variant has no price. Omitted means priced for
   *  compatibility with fixture and legacy variant literals. */
  hasPrice?: boolean;
  sellingPlans?: StoreSellingPlan[];
}

export interface StoreSellingPlan {
  id: string;
  name: string;
  cadence: string;
  priceAdjustment: { type: "fixed_price"; valueCents: number; currency: string } | null;
}

export function selectStorefrontPriceVariant(product: StoreProduct): StoreVariant | null {
  const priced = product.variants.filter((variant) => variant.hasPrice !== false);
  const sellable = priced.filter((variant) => variant.available);
  const candidates = sellable.length ? sellable : priced.length ? priced : product.variants;
  return candidates.slice().sort(
    (a, b) => a.priceCents - b.priceCents || a.id.localeCompare(b.id),
  )[0] ?? null;
}

export interface StoreCollection {
  id?: string;
  handle: string;
  title: string;
  description?: string;
  productCount?: number;
}
