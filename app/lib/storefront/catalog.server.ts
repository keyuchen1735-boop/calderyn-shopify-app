// app/lib/storefront/catalog.server.ts
// The single swap point between the fixture and the owned (DB-bound) catalog.
// This file is server-only (.server.ts) so the owned impl never reaches the
// client bundle. getCatalog() is invoked only from loaders.
import type { StorefrontCatalog } from "./catalog";
import { ownedCatalog } from "./catalog.owned.server";
import { fixtureCatalog } from "./catalog.stub.server";
import { DEMO_SHOP_ID } from "./shop.server";

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
  listCollections: (shopId) => pick(shopId).listCollections(shopId),
};

export function getCatalog(): StorefrontCatalog {
  return routingCatalog;
}
