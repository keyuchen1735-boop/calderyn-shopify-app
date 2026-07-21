// app/lib/storefront/catalog.stub.server.ts
// Default StorefrontCatalog implementation: a hard-coded in-memory fixture so the
// storefront shell renders with no database and no dependency on John's owned
// catalog. Swapped out behind getCatalog() once the owned impl lands.
import type {
  StorefrontCatalog,
  StorefrontCatalogSearchOptions,
  StorefrontCatalogSearchPage,
  StoreCollection,
  StoreProduct,
} from "./catalog";
import {
  decodeProductPageCursor,
  encodeProductPageCursor,
  MAX_PUBLIC_PRODUCT_PAGE_SIZE,
  storefrontPriceSortValue,
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

function searchSortValue(
  product: StoreProduct,
  sort: StorefrontCatalogSearchOptions["sort"],
): string | number {
  return sort === "price_asc" || sort === "price_desc" ? storefrontPriceSortValue(product, sort) : product.title;
}

function compareSearchProducts(a: StoreProduct, b: StoreProduct, sort: StorefrontCatalogSearchOptions["sort"]): number {
  if (sort === "title_desc") return b.title.localeCompare(a.title) || a.id.localeCompare(b.id);
  if (sort === "price_asc") return storefrontPriceSortValue(a, sort) - storefrontPriceSortValue(b, sort) || a.id.localeCompare(b.id);
  if (sort === "price_desc") return storefrontPriceSortValue(b, sort) - storefrontPriceSortValue(a, sort) || a.id.localeCompare(b.id);
  return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
}

function facet(groups: string[][]): Array<{ value: string; count: number }> {
  const counts = new Map<string, { value: string; count: number }>();
  for (const values of groups) {
    const perProduct = new Map<string, string>();
    for (const value of values) {
      if (!value) continue;
      const key = value.toLocaleLowerCase("en-US");
      const representative = perProduct.get(key);
      if (!representative || value < representative) perProduct.set(key, value);
    }
    for (const [key, value] of perProduct) {
      const current = counts.get(key);
      if (current) {
        current.count += 1;
        if (value < current.value) current.value = value;
      } else {
        counts.set(key, { value, count: 1 });
      }
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, 20);
}

export function searchProductPageInMemory(
  products: StoreProduct[],
  opts: StorefrontCatalogSearchOptions,
): StorefrontCatalogSearchPage {
  const lower = (value: string) => value.toLocaleLowerCase("en-US");
  const query = lower(opts.query);
  const filtered = products.filter((product) => {
    if (query && !lower(`${product.title} ${product.description} ${product.category ?? ""} ${(product.tags ?? []).join(" ")}`).includes(query)) return false;
    if (opts.collection && !product.collections.some((value) => lower(value) === lower(opts.collection!))) return false;
    if (opts.category && lower(product.category ?? "") !== lower(opts.category)) return false;
    if (opts.tag && !(product.tags ?? []).some((value) => lower(value) === lower(opts.tag!))) return false;
    if (opts.available !== null && product.variants.some((variant) => variant.available) !== opts.available) return false;
    return true;
  }).sort((a, b) => compareSearchProducts(a, b, opts.sort));
  const remaining = opts.after
    ? filtered.filter((product) => {
        const value = searchSortValue(product, opts.sort);
        if (typeof value !== typeof opts.after!.sortValue) return false;
        const direction = opts.sort === "title_desc" || opts.sort === "price_desc" ? -1 : 1;
        const order = typeof value === "number"
          ? (value - Number(opts.after!.sortValue)) * direction
          : String(value).localeCompare(String(opts.after!.sortValue)) * direction;
        return order > 0 || (order === 0 && product.id.localeCompare(opts.after!.productId) > 0);
      })
    : filtered;
  const items = remaining.slice(0, opts.limit);
  const hasNextPage = items.length < remaining.length;
  const last = items.at(-1);
  return {
    items,
    boundary: hasNextPage && last
      ? { sortValue: searchSortValue(last, opts.sort), productId: last.id }
      : null,
    facets: {
      categories: facet(filtered.map((product) => [product.category ?? ""])),
      tags: facet(filtered.map((product) => product.tags ?? [])),
      collections: facet(filtered.map((product) => product.collections)),
    },
    total: filtered.length,
    hasNextPage,
  };
}

// ponytail: single demo tenant — shopId is accepted (and required by the contract)
// but the fixture carries one tenant's data, so it cannot leak across shops. The
// owned impl MUST .eq('shop_id', shopId) on every query.
export const fixtureCatalog: StorefrontCatalog = {
  async searchProductPage(_shopId, opts) {
    return searchProductPageInMemory(PRODUCTS, opts);
  },

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
