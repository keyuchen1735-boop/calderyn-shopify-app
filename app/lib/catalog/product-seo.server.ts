// Search-listing plumbing for the product editor: read the stored seo_page
// override next to the deterministic defaults the storefront would serve
// without one, and persist the editor's override input. Shared by the
// dashboard.api.catalog.products routes (kept out of the route modules so no
// server-importing helper is exported from a route).
import { getSeoOverride, upsertSeoOverride, deleteSeoOverride } from "~/lib/seo/seo-store.server";
import { buildProductDraft, plainText, clampText } from "~/lib/seo/writer.server";
import { storefrontOrigin } from "~/lib/seo/origin.server";
import { getStoreSettings } from "~/lib/storefront/settings.server";
import { tenantStorefrontOrigin } from "~/lib/storefront/tenant-origin.server";
import type { ProductDetail, ProductInput } from "./types";

/** What the Search-listing card needs: the stored override (null fields = no
 *  override) plus the deterministic defaults the storefront serves without one. */
export interface SeoListingVM {
  metaTitle: string | null;
  metaDescription: string | null;
  defaultTitle: string;
  defaultDescription: string;
  /** Absolute prefix the handle is appended to (".../storefront/products/"). */
  urlPrefix: string;
}

// Assemble the card's defaults the same way the PDP serves them (settings +
// deterministic draft). Failure-isolated like the PDP's own meta build: a
// settings hiccup degrades the PLACEHOLDERS, it must not 500 the editor. The
// override read is load-bearing (a blind editor could clobber a stored
// override), so its errors propagate.
export async function seoListingFor(
  request: Request,
  shopId: string,
  product: ProductDetail,
): Promise<SeoListingVM> {
  const override = await getSeoOverride(shopId, "product", product.id);
  let defaultTitle = product.title;
  let defaultDescription = clampText(plainText(product.description ?? ""), 155);
  let origin = storefrontOrigin(request);
  try {
    const [settings, tenantOrigin] = await Promise.all([
      getStoreSettings(shopId),
      tenantStorefrontOrigin(shopId),
    ]);
    if (tenantOrigin) origin = tenantOrigin;
    const draft = buildProductDraft(
      {
        id: product.id,
        handle: product.handle,
        title: product.title,
        description: product.description ?? "",
        images: [],
        variants: [],
        collections: [],
      },
      settings,
      origin,
    );
    defaultTitle = draft.title;
    defaultDescription = draft.description;
  } catch (err) {
    console.error(`[dashboard.api] seo defaults build failed for shop ${shopId}:`, err);
  }
  return {
    metaTitle: override?.metaTitle ?? null,
    metaDescription: override?.metaDescription ?? null,
    defaultTitle,
    defaultDescription,
    urlPrefix: `${origin}/storefront/products/`,
  };
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
