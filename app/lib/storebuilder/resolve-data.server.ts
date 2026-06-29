// app/lib/storebuilder/resolve-data.server.ts
// Server-only: pre-load exactly the catalog data the document's blocks reference, so the pure
// renderer (renderBlocks) needs no async/DB. Every read is shop-scoped (shopId first arg).
import type { StorefrontCatalog } from "~/lib/storefront/catalog";
import type { BlockDocument, RenderData, RenderContext } from "./types";
import { getBlockMeta } from "./registry";

export async function resolveRenderData(
  doc: BlockDocument, shopId: string, catalog: StorefrontCatalog,
  record?: RenderContext["record"],
): Promise<RenderData> {
  // Gather refs across all blocks.
  const collectionHandles = new Set<string>();
  const productIds = new Set<string>();
  let needsAll = false;
  for (const block of doc.blocks) {
    const meta = getBlockMeta(block.type);
    if (!meta) continue;
    let props: Record<string, unknown>;
    try { props = meta.validateProps(block.props) as Record<string, unknown>; } catch { continue; }
    const refs = meta.catalogRefs(props);
    refs.collectionHandles.forEach((h) => collectionHandles.add(h));
    refs.productIds.forEach((id) => productIds.add(id));
    const source = (props.source as { kind?: string } | undefined)?.kind;
    if (block.type === "productGrid" && source === "all") needsAll = true;
    if (block.type === "collectionList") collectionHandles.add("*"); // sentinel: needs the full list
  }

  // Template docs bind dynamic blocks to the current record; a collectionGrid needs the
  // record collection's products. ponytail: add the record handle to the load set.
  if (record?.collection) collectionHandles.add(record.collection.handle);

  const wantsCollectionsList = collectionHandles.delete("*");
  const collections = wantsCollectionsList ? await catalog.listCollections(shopId) : [];
  const allProducts = needsAll ? await catalog.listProducts(shopId) : [];

  const productsByCollection: Record<string, Awaited<ReturnType<StorefrontCatalog["listProducts"]>>> = {};
  await Promise.all([...collectionHandles].map(async (handle) => {
    productsByCollection[handle] = await catalog.listProducts(shopId, { collection: handle });
  }));

  const productsById: Record<string, Awaited<ReturnType<StorefrontCatalog["getProduct"]>> & object> = {};
  await Promise.all([...productIds].map(async (id) => {
    // ponytail: getProduct is keyed by handle; the fixture handle is `h-<id>`. The owned
    // catalog (#5) will expose id lookups — until then explicit-id grids resolve by that
    // convention. Acceptable: explicit-id grids are author-chosen, validated against real ids.
    const prod = await catalog.getProduct(shopId, `h-${id}`);
    if (prod) productsById[id] = prod;
  }));

  return { collections, productsByCollection, productsById, allProducts };
}
