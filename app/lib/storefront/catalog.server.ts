// app/lib/storefront/catalog.server.ts
// The single swap point between the fixture and the owned (DB-bound) catalog.
// This file is server-only (.server.ts) so the owned impl never reaches the
// client bundle. getCatalog() is invoked only from loaders.
import type { StorefrontCatalog } from "./catalog";
import { ownedCatalog } from "./catalog.owned.server";
import { fixtureCatalog } from "./catalog.stub.server";
import { DEMO_SHOP_ID } from "./shop.server";
import { applyAssetOverrides } from "~/lib/storegen/imagery/asset.server";

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
  listProducts: (shopId, opts) => pick(shopId).listProducts(shopId, opts),
  getProduct: (shopId, handle) => pick(shopId).getProduct(shopId, handle),
  getVariantById: (shopId, variantId) => pick(shopId).getVariantById?.(shopId, variantId) ?? Promise.resolve(null),
  listCollections: (shopId) => pick(shopId).listCollections(shopId),
  getCollection: (shopId, handle) => pick(shopId).getCollection?.(shopId, handle) ?? Promise.resolve(null),
};

const previewCatalog: StorefrontCatalog = {
  ...routingCatalog,
  listProducts: async (shopId, opts) => applyAssetOverrides(shopId, await routingCatalog.listProducts(shopId, opts)),
  getProduct: async (shopId, handle) => {
    const product = await routingCatalog.getProduct(shopId, handle);
    return product ? (await applyAssetOverrides(shopId, [product]))[0] ?? null : null;
  },
};

export function getCatalog(): StorefrontCatalog {
  return routingCatalog;
}

export function getPreviewCatalog(): StorefrontCatalog {
  return previewCatalog;
}
