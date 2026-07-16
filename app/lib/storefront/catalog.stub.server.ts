// app/lib/storefront/catalog.stub.server.ts
// Default StorefrontCatalog implementation: a hard-coded in-memory fixture so the
// storefront shell renders with no database and no dependency on John's owned
// catalog. Swapped out behind getCatalog() once the owned impl lands.
import type {
  StorefrontCatalog,
  StoreCollection,
  StoreProduct,
} from "./catalog";
import {
  decodeProductPageCursor,
  encodeProductPageCursor,
  MAX_PUBLIC_PRODUCT_PAGE_SIZE,
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
  async listProductPage(_shopId, opts) {
    let products = [...PRODUCTS];
    if (opts.collection) products = products.filter((product) => product.collections.includes(opts.collection!));
    if (opts.query) {
      const query = opts.query.toLocaleLowerCase();
      products = products.filter((product) => `${product.title} ${product.description}`.toLocaleLowerCase().includes(query));
    }
    products.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    const cursor = opts.cursor ? decodeProductPageCursor(opts.cursor) : null;
    const remaining = cursor
      ? products.filter((product) => product.title.localeCompare(cursor.title) > 0 ||
          (product.title === cursor.title && product.id.localeCompare(cursor.id) > 0))
      : products;
    const limit = Math.min(Math.max(Math.trunc(opts.limit), 1), MAX_PUBLIC_PRODUCT_PAGE_SIZE);
    const items = remaining.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: last && remaining.length > items.length ? encodeProductPageCursor(last.title, last.id) : null,
    };
  },
  async listProducts(_shopId, opts) {
    let products = opts?.ids ? PRODUCTS.filter((p) => opts.ids!.includes(p.id)) : PRODUCTS;
    if (opts?.collection) products = products.filter((p) => p.collections.includes(opts.collection!));
    if (opts?.query) {
      const query = opts.query.toLocaleLowerCase();
      products = products.filter((p) => `${p.title} ${p.description}`.toLocaleLowerCase().includes(query));
    }
    return products.slice(0, opts?.limit);
  },
  async getProduct(_shopId, handle) {
    return PRODUCTS.find((p) => p.handle === handle) ?? null;
  },
  async getVariantById(_shopId, variantId) {
    for (const product of PRODUCTS) {
      const variant = product.variants.find((entry) => entry.id === variantId);
      if (variant) return { product, variant };
    }
    return null;
  },
  async getCollection(_shopId, handle) {
    const collection = COLLECTIONS.find((entry) => entry.handle === handle);
    return collection
      ? { ...collection, productCount: PRODUCTS.filter((product) => product.collections.includes(handle)).length }
      : null;
  },
  async listCollections(_shopId) {
    return COLLECTIONS;
  },
};
