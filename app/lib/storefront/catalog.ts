// app/lib/storefront/catalog.ts
// The shared catalog read contract. John implements this verbatim against the
// owned catalog later (master spec §#5); the fixture stub implements it now.
// shopId is the first argument of every method — every implementation MUST scope
// its reads to that shopId (the contract-level defense against cross-tenant leakage
// on this public, unauthenticated surface; there is no Postgres RLS).
export interface StorefrontCatalog {
  /** opts.ids restricts to explicit product ids (curated grids) — implementations must
   *  scope the id read to the shop and skip the full-catalog fetch. */
  listProducts(shopId: string, opts?: { collection?: string; ids?: string[] }): Promise<StoreProduct[]>;
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
  category?: string | null;
  tags?: string[];
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
