// app/lib/storefront/catalog.server.ts
// The single swap point between the default fixture and John's eventual owned
// (DB-bound) implementation. This file is server-only (.server.ts) so the owned
// impl never reaches the client bundle. getCatalog() is invoked only from loaders.
import type { StorefrontCatalog } from "./catalog";
import { fixtureCatalog } from "./catalog.stub.server";

export function getCatalog(): StorefrontCatalog {
  // ponytail: fixture by default so the shell renders with no DB. The ENTIRE swap
  // to John's owned catalog (master spec §#5) is one line:
  //   return ownedCatalog; // once ./catalog.owned.server.ts exists
  return fixtureCatalog;
}
