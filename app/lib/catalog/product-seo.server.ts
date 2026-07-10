// Search-listing plumbing for the product editor: read the stored seo_page
// override next to the deterministic defaults the storefront would serve
// without one, and persist the editor's override input (the catalog layer's
// createProduct/updateProduct call applySeoOverrideInput when input.seo is
// present, so every caller — routes, assistant actions — persists it).
import { getSeoOverride, upsertSeoOverride, deleteSeoOverride } from "~/lib/seo/seo-store.server";
import { buildProductDraft } from "~/lib/seo/writer.server";
import { storefrontOrigin } from "~/lib/seo/origin.server";
import { getStoreSettings } from "~/lib/storefront/settings.server";
import { getShopStorefrontOrigin } from "~/lib/storefront/shop.server";
import type { ProductDetail, ProductInput, SeoListingVM } from "./types";

// Assemble the card's data the same way the PDP serves it (override + settings
// + deterministic draft). FULLY fail-soft: the card is decoration on the
// editor, so if ANY read fails we log and return null — the editor renders the
// card as temporarily unavailable and omits `seo` from the save payload (a
// blind save could otherwise clobber a stored override it never loaded). The
// three reads only need ids, so `product` may be the in-flight getProduct
// promise — everything runs concurrently with it.
export async function seoListingFor(
  request: Request,
  shopId: string,
  productId: string,
  product: ProductDetail | Promise<ProductDetail | null>,
): Promise<SeoListingVM | null> {
  try {
    const [override, settings, tenantOrigin, p] = await Promise.all([
      getSeoOverride(shopId, "product", productId),
      getStoreSettings(shopId),
      getShopStorefrontOrigin(shopId),
      product,
    ]);
    if (!p) return null;
    // No tenant slug yet ("") → fall back to the request-derived origin.
    const origin = tenantOrigin || storefrontOrigin(request);
    const draft = buildProductDraft(
      {
        id: p.id,
        handle: p.handle,
        title: p.title,
        description: p.description ?? "",
        images: [],
        variants: [],
        collections: [],
      },
      settings,
      origin,
    );
    return {
      metaTitle: override?.metaTitle ?? null,
      metaDescription: override?.metaDescription ?? null,
      defaultTitle: draft.title,
      defaultDescription: draft.description,
      urlPrefix: `${origin}/storefront/products/`,
    };
  } catch (err) {
    console.error(`[dashboard.api] search-listing load failed for shop ${shopId}:`, err);
    return null;
  }
}

/** Persist the validated seo block: both fields empty removes the override
 *  (the deterministic draft wins again), anything else upserts it. */
export async function applySeoOverrideInput(
  shopId: string,
  productId: string,
  seo: NonNullable<ProductInput["seo"]>,
): Promise<void> {
  if (!seo.metaTitle && !seo.metaDescription) {
    await deleteSeoOverride(shopId, "product", productId);
    return;
  }
  await upsertSeoOverride(shopId, {
    entityType: "product",
    entityId: productId,
    metaTitle: seo.metaTitle || null,
    metaDescription: seo.metaDescription || null,
  });
}
