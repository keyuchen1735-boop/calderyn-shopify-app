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
