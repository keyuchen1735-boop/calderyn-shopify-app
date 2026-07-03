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
const SOURCE = "higgsfield";

export interface EnhanceResult { productId: string; status: "ready" | "failed"; url: string | null }

export async function enhanceListing(shopId: string, product: StoreProduct): Promise<EnhanceResult> {
  if (!UUID_RE.test(shopId)) throw new Error(`enhanceListing requires a real (uuid) shop_id, got ${shopId}`);
  const sb = getSupabase();
  let url: string | null = null;
  let status: "ready" | "failed" = "failed";
  try {
    const out = await getImageProvider().generateListingImage({
      productTitle: product.title, productDescription: product.description,
      sourceImageUrl: product.images[0]?.url ?? null, mode: "product_shot",
    });
    status = "ready";
    // Higgsfield returns an EPHEMERAL provider URL that expires; capture it into
    // owned storage so the stored store_asset.url — which the storefront read
    // path serves to buyers — is stable and self-hosted. persistExternalImage
    // never throws: on a persistence failure it logs and returns the ephemeral
    // url, so the image still renders (rule 12) and the row stays 'ready'.
    url = (await persistExternalImage(shopId, out.url, "generated", "generated")).url;
  } catch {
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

export async function applyAssetOverrides(shopId: string, products: StoreProduct[]): Promise<StoreProduct[]> {
  if (!UUID_RE.test(shopId)) return products;
  const { data, error } = await getSupabase().from("store_asset").select("product_id, url, status").eq("shop_id", shopId);
  if (error) throw error;
  const ready = new Map((data ?? []).filter((r) => r.status === "ready" && r.url).map((r) => [r.product_id as string, r.url as string]));
  if (ready.size === 0) return products;
  return products.map((p) => {
    const url = ready.get(p.id);
    if (!url) return p;
    return { ...p, images: [{ url, alt: p.images[0]?.alt ?? p.title }, ...p.images.slice(1)] };
  });
}
