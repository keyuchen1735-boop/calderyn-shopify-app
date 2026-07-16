// app/lib/storefront/catalog.ts
// The shared catalog read contract. John implements this verbatim against the
// owned catalog later (master spec §#5); the fixture stub implements it now.
// shopId is the first argument of every method — every implementation MUST scope
// its reads to that shopId (the contract-level defense against cross-tenant leakage
// on this public, unauthenticated surface; there is no Postgres RLS).
export const MAX_PUBLIC_PRODUCT_PAGE_SIZE = 24;

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
}

export interface StoreCollection {
  id?: string;
  handle: string;
  title: string;
  description?: string;
  productCount?: number;
}
