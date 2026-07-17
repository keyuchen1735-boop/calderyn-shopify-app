// app/lib/storefront/catalog.server.ts
// The single swap point between the fixture and the owned (DB-bound) catalog.
// This file is server-only (.server.ts) so the owned impl never reaches the
// client bundle. getCatalog() is invoked only from loaders.
import type { StorefrontCatalog } from "./catalog";
import { decodeProductPageCursor, encodeProductPageCursor, MAX_PUBLIC_PRODUCT_PAGE_SIZE } from "./catalog";
import { listOwnedPreviewProducts, ownedCatalog } from "./catalog.owned.server";
import { fixtureCatalog, searchProductPageInMemory } from "./catalog.stub.server";
import { DEMO_SHOP_ID } from "./shop.server";
import { withAssetOverrides } from "~/lib/storegen/imagery/asset.server";

// Route per call on the shopId every catalog method already receives: real tenants
// read the owned catalog; EXACTLY the demo sentinel reads the in-memory stub. The
// owned tables key shop_id as uuid, so letting "demo-shop" reach them is a
// guaranteed Postgres type error (22P02) — the fixture is the no-DB path. Any
// OTHER malformed shopId still hits the owned catalog and fails loudly rather
// than silently serving fixture products to a merchant surface.
function pick(shopId: string): StorefrontCatalog {
  return shopId === DEMO_SHOP_ID ? fixtureCatalog : ownedCatalog;
}

const routingCatalog: StorefrontCatalog = {
  searchProductPage: (shopId, opts) => pick(shopId).searchProductPage(shopId, opts),
  listProductPage: (shopId, opts) => pick(shopId).listProductPage(shopId, opts),
  listProducts: (shopId, opts) => pick(shopId).listProducts(shopId, opts),
  getProduct: (shopId, handle) => pick(shopId).getProduct(shopId, handle),
  getVariantById: (shopId, variantId) => pick(shopId).getVariantById?.(shopId, variantId) ?? Promise.resolve(null),
  listCollections: (shopId) => pick(shopId).listCollections(shopId),
  getCollection: (shopId, handle) => pick(shopId).getCollection?.(shopId, handle) ?? Promise.resolve(null),
};

const catalogWithReadyAssets = withAssetOverrides(routingCatalog);

const previewOwnedCatalog: StorefrontCatalog = {
  async searchProductPage(shopId, opts) {
    return searchProductPageInMemory(await listOwnedPreviewProducts(shopId), opts);
  },
  async listProductPage(shopId, opts) {
    const products = await listOwnedPreviewProducts(shopId, {
      ...(opts.collection ? { collection: opts.collection } : {}),
      ...(opts.query ? { query: opts.query } : {}),
    });
    const cursor = opts.cursor ? decodeProductPageCursor(opts.cursor) : null;
    const remaining = cursor
      ? products.filter((product) => product.title.localeCompare(cursor.title) > 0
        || (product.title === cursor.title && product.id.localeCompare(cursor.id) > 0))
      : products;
    const limit = Math.min(Math.max(Math.trunc(opts.limit), 1), MAX_PUBLIC_PRODUCT_PAGE_SIZE);
    const items = remaining.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: last && remaining.length > items.length ? encodeProductPageCursor(last.title, last.id) : null,
    };
  },
  listProducts: listOwnedPreviewProducts,
  async getProduct(shopId, handle) {
    return (await listOwnedPreviewProducts(shopId)).find((product) => product.handle === handle) ?? null;
  },
  getVariantById: ownedCatalog.getVariantById,
  getCollection: ownedCatalog.getCollection,
  listCollections: ownedCatalog.listCollections,
};

const previewCatalogWithReadyAssets = withAssetOverrides({
  searchProductPage: (shopId, opts) => pick(shopId) === fixtureCatalog
    ? fixtureCatalog.searchProductPage(shopId, opts)
    : previewOwnedCatalog.searchProductPage(shopId, opts),
  listProductPage: (shopId, opts) => pick(shopId) === fixtureCatalog
    ? fixtureCatalog.listProductPage(shopId, opts)
    : previewOwnedCatalog.listProductPage(shopId, opts),
  listProducts: (shopId, opts) => pick(shopId) === fixtureCatalog
    ? fixtureCatalog.listProducts(shopId, opts)
    : previewOwnedCatalog.listProducts(shopId, opts),
  getProduct: (shopId, handle) => pick(shopId) === fixtureCatalog
    ? fixtureCatalog.getProduct(shopId, handle)
    : previewOwnedCatalog.getProduct(shopId, handle),
  getVariantById: routingCatalog.getVariantById,
  getCollection: routingCatalog.getCollection,
  listCollections: routingCatalog.listCollections,
});

export function getCatalog(): StorefrontCatalog {
  return catalogWithReadyAssets;
}

export function getPreviewCatalog(): StorefrontCatalog {
  return previewCatalogWithReadyAssets;
}
