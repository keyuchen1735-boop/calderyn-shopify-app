import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import {
  dashboardJson,
  jsonError,
  requireSameOrigin,
} from "~/lib/dashboard/http.server";
import {
  getProduct,
  updateProduct,
  setProductStatus,
} from "~/lib/catalog/catalog.server";
import { signMediaPaths } from "~/lib/catalog/sign-media.server";
import { validateProductInput } from "~/lib/catalog/validate";
import { seoListingFor } from "~/lib/catalog/product-seo.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const id = String(params.id);
  return dashboardJson(async () => {
    // The search-listing reads only need ids, so they run concurrently with the
    // product fetch itself (seoListingFor awaits the same promise internally and
    // is fully fail-soft — null renders the card as temporarily unavailable).
    const productPromise = getProduct(session.shopId, id);
    const seoPromise = seoListingFor(
      request,
      session.shopId,
      id,
      productPromise,
    );
    const product = await productPromise;
    if (!product) throw jsonError(404, "not_found");
    // Reshape the stored detail into the editor view-model:
    //  - options are stored with value rows {id,value}; the editor wants string[]
    //  - variants reference option VALUE IDS, but the editor, buildVariantMatrix,
    //    and the write path all key off LABELS, so resolve ids -> labels here
    //  - media storage paths -> short-lived signed URLs (private bucket)
    //  - nullable scalars (vendor/category/description) -> undefined so an edit
    //    that doesn't surface a field round-trips it instead of nulling it
    const [signed, seoListing] = await Promise.all([
      signMediaPaths(product.media.map((m) => m.storagePath)),
      seoPromise,
    ]);
    const labelById = new Map<string, string>();
    for (const o of product.options)
      for (const v of o.values) labelById.set(v.id, v.value);
    return {
      product: {
        id: product.id,
        handle: product.handle,
        title: product.title,
        status: product.status,
        vendor: product.vendor ?? undefined,
        category: product.category ?? undefined,
        description: product.description ?? undefined,
        tags: product.tags,
        options: product.options.map((o) => ({
          name: o.name,
          values: o.values.map((v) => v.value),
        })),
        variants: product.variants.map((v) => ({
          id: v.id,
          sku: v.sku ?? undefined,
          title: v.title,
          retailPriceCents: v.retailPriceCents ?? undefined,
          compareAtPriceCents: v.compareAtPriceCents ?? undefined,
          unitCostCents: v.unitCostCents ?? undefined,
          inventoryTracked: v.inventoryTracked ?? undefined,
          inventoryOnHand: v.inventoryOnHand,
          optionValues: v.optionValueIds
            .map((vid) => labelById.get(vid))
            .filter((s): s is string => Boolean(s)),
          weightGrams: v.weightGrams ?? undefined,
          lengthMm: v.lengthMm ?? undefined,
          widthMm: v.widthMm ?? undefined,
          heightMm: v.heightMm ?? undefined,
          requiresShipping: v.requiresShipping ?? undefined,
          handlingDays: v.handlingDays ?? undefined,
          signatureRequired: v.signatureRequired ?? undefined,
          restrictedCountries: v.restrictedCountries ?? undefined,
        })),
        media: product.media.map((m) => ({
          id: m.id,
          url: signed.get(m.storagePath) ?? "",
          isPrimary: m.isPrimary,
          alt: m.alt,
          position: m.position,
        })),
        collectionIds: product.collectionIds,
        updatedAt: product.updatedAt,
        seoListing,
      },
    };
  });
}

export async function action({ request, params }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  const id = String(params.id);

  if (request.method === "DELETE") {
    return dashboardJson(async () => {
      await setProductStatus(session.shopId, id, "archived");
      return { ok: true };
    });
  }
  if (request.method === "PUT") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError(422, "invalid_json");
    }
    return dashboardJson(async () => {
      // The complete editor payload may carry an already-active legacy variant
      // that predates required shipping dimensions. Validation compares its
      // shipping fields with this authoritative snapshot: unchanged legacy data
      // may round-trip, while activation and shipping edits remain gated.
      const previous = await getProduct(session.shopId, id);
      if (!previous) throw jsonError(404, "not_found");
      const v = validateProductInput(body, { previous });
      if (!v.ok) throw jsonError(422, v.code);
      await updateProduct(session.shopId, id, v.value);
      return { ok: true };
    });
  }
  return jsonError(405, "method_not_allowed");
}
