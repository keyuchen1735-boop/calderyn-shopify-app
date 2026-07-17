// app/lib/storegen/imagery/asset.server.ts
// store_asset repo + the catalog fallback. enhanceListing generates ONE conversion image for a
// selected product via the seam and records it (ready/failed, rule 12). applyAssetOverrides fills
// missing product media with the latest ready asset without replacing merchant-owned imagery.
import { getSupabase } from "~/lib/supabase.server";
import type { StorefrontCatalog, StoreProduct } from "~/lib/storefront/catalog";
import { persistExternalImage } from "~/lib/assets/persist.server";
import { getImageProvider } from "./provider.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE = "gemini";
const ASSET_PRODUCT_CHUNK_SIZE = 100;
const POSTGREST_PAGE_SIZE = 1000;

export interface EnhanceResult { productId: string; status: "ready" | "failed"; url: string | null }

export interface StoreAssetOverrideQuery {
  shopId: string;
  status: "ready";
  productIds: readonly string[];
  from: number;
  to: number;
}

export interface StoreAssetOverrideDependencies {
  queryReadyAssets(input: StoreAssetOverrideQuery): Promise<{
    data: Array<Record<string, unknown>> | null;
    error: unknown;
  }>;
}

const defaultAssetOverrideDependencies: StoreAssetOverrideDependencies = {
  queryReadyAssets: async ({ shopId, status, productIds, from, to }) => getSupabase()
    .from("store_asset")
    .select("product_id, source, url, status, created_at")
    .eq("shop_id", shopId)
    .eq("status", status)
    .in("product_id", productIds)
    .order("product_id")
    .order("created_at", { ascending: false })
    .order("source")
    .range(from, to),
};

export async function enhanceListing(shopId: string, product: StoreProduct, opts: { signal?: AbortSignal } = {}): Promise<EnhanceResult> {
  if (!UUID_RE.test(shopId)) throw new Error(`enhanceListing requires a real (uuid) shop_id, got ${shopId}`);
  const sb = getSupabase();
  let url: string | null = null;
  let status: "ready" | "failed" = "failed";
  try {
    const out = await getImageProvider().generateListingImage({
      shopId,
      productTitle: product.title, productDescription: product.description,
      sourceImageUrl: product.images[0]?.url ?? null, mode: "product_shot",
      signal: opts.signal,
    });
    status = "ready";
    // Capture Gemini's inline image into owned storage before previewing it.
    const persisted = await persistExternalImage(shopId, out.url, "generated", "generated", { signal: opts.signal });
    if (!persisted.persisted && out.url.startsWith("data:image/")) throw new Error("Gemini image persistence failed");
    url = persisted.url;
    if (opts.signal?.aborted) return { productId: product.id, status: "failed", url: null };
  } catch {
    if (opts.signal?.aborted) return { productId: product.id, status: "failed", url: null };
    status = "failed"; // keep the source image; surfaced as a failed asset row
  }
  // url is NOT NULL in store_asset; "" is the sentinel for failed rows. It is never surfaced
  // because applyAssetOverrides filters on status === "ready" && r.url.
  // A failed attempt must NOT clobber a previously-ready asset: re-builds re-run
  // generation for every image-less product, so a transient provider failure
  // would otherwise wipe a good image. On failure we only insert when no row
  // exists yet (rule-12 visibility); a successful run always overwrites.
  const { error } = await sb.from("store_asset").upsert(
    { shop_id: shopId, product_id: product.id, source: SOURCE, url: url ?? "", status, created_at: new Date().toISOString() },
    { onConflict: "shop_id,product_id,source", ignoreDuplicates: status === "failed" },
  );
  if (error) throw error;
  return { productId: product.id, status, url };
}

/** Generate photos for catalog products that have none, capped per build.
 *  Restored for the designer engine's first builds (fail-soft at call sites). */
export async function generateMissingListingImages(
  shopId: string,
  products: StoreProduct[],
  enhance: typeof enhanceListing = enhanceListing,
  signal?: AbortSignal,
  limit = 3,
): Promise<number> {
  if (products.length === 0 || limit <= 0) return 0;
  const missing = products
    .filter((product) => product.images.length === 0)
    // An explicit limit is the caller's budget decision; the constant is only
    // the default for callers that don't pass one.
    .slice(0, Math.max(0, limit));
  const results = await Promise.all(missing.map((product) => enhance(shopId, product, { signal })));
  return results.filter((result) => result.status === "ready").length;
}

export async function applyAssetOverrides(
  shopId: string,
  products: StoreProduct[],
  dependencies: StoreAssetOverrideDependencies = defaultAssetOverrideDependencies,
): Promise<StoreProduct[]> {
  if (!UUID_RE.test(shopId)) return products;
  const imageLessIds = [...new Set(products.filter((product) => product.images.length === 0).map((product) => product.id))];
  if (imageLessIds.length === 0) return products;
  const chunks: string[][] = [];
  for (let index = 0; index < imageLessIds.length; index += ASSET_PRODUCT_CHUNK_SIZE) {
    chunks.push(imageLessIds.slice(index, index + ASSET_PRODUCT_CHUNK_SIZE));
  }
  const chunkRows = await Promise.all(chunks.map(async (chunk) => {
    const rows: Array<Record<string, unknown>> = [];
    for (let from = 0; ; from += POSTGREST_PAGE_SIZE) {
      const result = await dependencies.queryReadyAssets({
        shopId,
        status: "ready",
        productIds: chunk,
        from,
        to: from + POSTGREST_PAGE_SIZE - 1,
      });
      if (result.error) throw result.error;
      const page = (result.data ?? []) as Array<Record<string, unknown>>;
      rows.push(...page);
      if (page.length < POSTGREST_PAGE_SIZE) break;
    }
    return rows;
  }));
  const ready = new Map<string, string>();
  const rows = chunkRows.flat().sort((a, b) =>
    String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")) ||
    String(a.product_id ?? "").localeCompare(String(b.product_id ?? "")) ||
    String(a.source ?? "").localeCompare(String(b.source ?? "")) ||
    String(a.url ?? "").localeCompare(String(b.url ?? "")),
  );
  for (const row of rows) {
    if (row.status === "ready" && row.url && !ready.has(String(row.product_id))) ready.set(String(row.product_id), String(row.url));
  }
  if (ready.size === 0) return products;
  return products.map((p) => {
    const url = ready.get(p.id);
    if (!url || p.images.length > 0) return p;
    return { ...p, images: [{ url, alt: p.title }] };
  });
}

export function withAssetOverrides(
  catalog: StorefrontCatalog,
  dependencies: StoreAssetOverrideDependencies = defaultAssetOverrideDependencies,
): StorefrontCatalog {
  return {
    ...catalog,
    searchProductPage: async (shopId, options) => {
      const page = await catalog.searchProductPage(shopId, options);
      return { ...page, items: await applyAssetOverrides(shopId, page.items, dependencies) };
    },
    listProductPage: async (shopId, options) => {
      const page = await catalog.listProductPage(shopId, options);
      return { ...page, items: await applyAssetOverrides(shopId, page.items, dependencies) };
    },
    listProducts: async (shopId, options) =>
      applyAssetOverrides(shopId, await catalog.listProducts(shopId, options), dependencies),
    getProduct: async (shopId, handle) => {
      const product = await catalog.getProduct(shopId, handle);
      return product ? (await applyAssetOverrides(shopId, [product], dependencies))[0] ?? null : null;
    },
  };
}
