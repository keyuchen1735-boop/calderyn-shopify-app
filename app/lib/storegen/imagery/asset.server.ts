// app/lib/storegen/imagery/asset.server.ts
// store_asset repo + the catalog override. enhanceListing generates ONE conversion image for a
// selected product via the seam and records it (ready/failed, rule 12). applyAssetOverrides swaps
// a product's primary image with its latest ready asset. It is wired into the draft PREVIEW this
// cycle; the live storefront read path adopts it with the publish flow (editor, sub-project 2).
import { getSupabase } from "~/lib/supabase.server";
import type { StoreProduct } from "~/lib/storefront/catalog";
import { persistExternalImage } from "~/lib/assets/persist.server";
import { getImageProvider } from "./provider.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE = "gemini";

export interface EnhanceResult { productId: string; status: "ready" | "failed"; url: string | null }

export async function enhanceListing(shopId: string, product: StoreProduct, opts: { signal?: AbortSignal } = {}): Promise<EnhanceResult> {
  if (!UUID_RE.test(shopId)) throw new Error(`enhanceListing requires a real (uuid) shop_id, got ${shopId}`);
  const sb = getSupabase();
  let url: string | null = null;
  let status: "ready" | "failed" = "failed";
  try {
    const out = await getImageProvider().generateListingImage({
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
  const { error } = await sb.from("store_asset").upsert(
    { shop_id: shopId, product_id: product.id, source: SOURCE, url: url ?? "", status, created_at: new Date().toISOString() },
    { onConflict: "shop_id,product_id,source" },
  );
  if (error) throw error;
  return { productId: product.id, status, url };
}

export async function generateMissingListingImages(
  shopId: string,
  products: StoreProduct[],
  enhance: typeof enhanceListing = enhanceListing,
  signal?: AbortSignal,
): Promise<number> {
  if (products.length === 0 || products.some((product) => product.images.length > 0)) return 0;
  // ponytail: the first recipe renders at most 12 featured products; add queued catalog-wide generation if that ceiling changes.
  const results = await Promise.all(products.slice(0, 12).map((product) => enhance(shopId, product, { signal })));
  return results.filter((result) => result.status === "ready").length;
}

export async function applyAssetOverrides(shopId: string, products: StoreProduct[]): Promise<StoreProduct[]> {
  if (!UUID_RE.test(shopId)) return products;
  const { data, error } = await getSupabase().from("store_asset").select("product_id, url, status, created_at").eq("shop_id", shopId);
  if (error) throw error;
  const ready = new Map<string, string>();
  for (const row of [...(data ?? [])].sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))) {
    if (row.status === "ready" && row.url && !ready.has(String(row.product_id))) ready.set(String(row.product_id), String(row.url));
  }
  if (ready.size === 0) return products;
  return products.map((p) => {
    const url = ready.get(p.id);
    if (!url) return p;
    return { ...p, images: [{ url, alt: p.images[0]?.alt ?? p.title }, ...p.images.slice(1)] };
  });
}
