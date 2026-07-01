// app/lib/storefront/catalog.server.ts
// The single swap point between the default fixture and John's eventual owned
// (DB-bound) implementation. This file is server-only (.server.ts) so the owned
// impl never reaches the client bundle. getCatalog() is invoked only from loaders.
import type { StorefrontCatalog } from "./catalog";
import { ownedCatalog } from "./catalog.owned.server";

export function getCatalog(): StorefrontCatalog {
  // The storefront now reads the owned catalog (Slice 1 tables) instead of the
  // in-memory fixture. The fixture (./catalog.stub.server) is kept for tests and
  // as a no-DB fallback; flip this back to `fixtureCatalog` to disable owned reads.
  return ownedCatalog;
}
