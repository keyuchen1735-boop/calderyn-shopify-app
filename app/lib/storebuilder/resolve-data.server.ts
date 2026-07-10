// app/lib/storebuilder/resolve-data.server.ts
// Server-only: pre-load exactly the catalog data the document's blocks reference, so the pure
// renderer (renderBlocks) needs no async/DB. Every read is shop-scoped (shopId first arg).
import type { StorefrontCatalog } from "~/lib/storefront/catalog";
import type { BlockDocument, RenderData, RenderContext } from "./types";
import { getBlockMeta } from "./registry";
import { boostByWeather, type WeatherCondition } from "~/lib/weather/affinity";

export async function resolveRenderData(
  doc: BlockDocument, shopId: string, catalog: StorefrontCatalog,
  record?: RenderContext["record"],
  // Visitor's current weather condition (resolved from their request in the
  // loader). Floats weather-relevant products to the top of the all-products and
  // collection grids for THIS shopper; "neutral" is a no-op. Curated explicit-id
  // grids (productsById) are never reordered — the merchant hand-picked them.
  weatherCondition: WeatherCondition = "neutral",
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
  // record collection's products. Only load the record handle when a collectionGrid is
  // present to consume it, so unrelated template docs skip the extra query.
  if (record?.collection && doc.blocks.some((b) => b.type === "collectionGrid")) {
    collectionHandles.add(record.collection.handle);
  }

  const wantsCollectionsList = collectionHandles.delete("*");
  const collections = wantsCollectionsList ? await catalog.listCollections(shopId) : [];
  const allProducts = boostByWeather(needsAll ? await catalog.listProducts(shopId) : [], weatherCondition);

  // Null-prototype dictionaries: keys are catalog refs carried from the stored document (not
  // re-validated at render time), so a ref like "__proto__" must land as a plain own key, never
  // touch the prototype chain.
  const productsByCollection: Record<string, Awaited<ReturnType<StorefrontCatalog["listProducts"]>>> = Object.create(null);
  await Promise.all([...collectionHandles].map(async (handle) => {
    productsByCollection[handle] = boostByWeather(
      await catalog.listProducts(shopId, { collection: handle }),
      weatherCondition,
    );
  }));

  // Explicit-id grids resolve against the catalog BY ID (getProduct is keyed by handle, and no
  // handle convention encodes an id). The needsAll fetch above is reused when present; otherwise
  // an id-scoped listProducts fetches only the referenced products — never the whole catalog on
  // this hot path. Unknown ids drop silently — validation already vouched for them, so a miss
  // here means the product was deleted since.
  const productsById: Record<string, Awaited<ReturnType<StorefrontCatalog["getProduct"]>> & object> = Object.create(null);
  if (productIds.size > 0) {
    const pool = needsAll ? allProducts : await catalog.listProducts(shopId, { ids: [...productIds] });
    const byId = new Map(pool.map((p) => [p.id, p]));
    for (const id of productIds) {
      const prod = byId.get(id);
      if (prod) productsById[id] = prod;
    }
  }

  return { collections, productsByCollection, productsById, allProducts };
}
