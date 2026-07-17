// app/routes/storefront.products.$handle.tsx
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs, MetaDescriptor, MetaFunction } from "@remix-run/node";
import { resolveDesignerPublicPage } from "~/lib/designer/serve.server";
import DesignerPublicView from "~/components/storefront/DesignerPublicView";
import { isDesignerPublicPage } from "~/lib/designer/types";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { resolveHandleRedirect } from "~/lib/storefront/handle-redirect.server";
import { resolveStorefrontShop, DEMO_SHOP_ID } from "~/lib/storefront/shop.server";
import { readCartId, commitCartId } from "~/lib/storefront/cart-cookie.server";
import { trackStorefrontEvent } from "~/lib/storefront/events.server";
import { appendStorefrontTrackingCookies } from "~/lib/storefront/visitor-cookie.server";
import { buildCart, addCartLine, VariantUnavailableError } from "~/lib/order/cart.server";
import { rateLimit, clientIpKey } from "~/lib/rate-limit.server";
import { randomBytes } from "node:crypto";
import { resolveRuntime1Route } from "~/lib/storefront-runtime/release-resolution.server";
import { isRuntime1RenderData, renderStorefrontSurface } from "~/lib/storefront-runtime/render";
import { markStorefrontBundleRendered } from "~/lib/storefront-runtime/csp.server";
import { storefrontCacheHeaders } from "~/lib/storefront-runtime/cache.server";
import { StorefrontHydrator } from "~/lib/storefront-runtime/storefront-hydrator";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { getStoreSettings } from "~/lib/storefront/settings.server";
import { buildProductDraft } from "~/lib/seo/writer.server";
import { safeMetaFromDraft } from "~/lib/seo/render.server";
import { storefrontOrigin } from "~/lib/seo/origin.server";
import { getSeoOverride } from "~/lib/seo/seo-store.server";
import { applyOverride } from "~/lib/seo/override";

export const meta: MetaFunction<typeof loader> = ({ data }) => data?.seoMeta ?? [{ title: "Product" }];
export const headers: HeadersFunction = ({ loaderHeaders }) => loaderHeaders;

async function redirectRenamedProductHandle(request: Request, shopId: string, handle: string): Promise<void> {
  let currentHandle: string | null = null;
  try {
    currentHandle = await resolveHandleRedirect(shopId, handle);
  } catch (err) {
    console.error(`[storefront] handle-redirect lookup failed for shop ${shopId}:`, err);
  }
  if (!currentHandle) return;
  const url = new URL(request.url);
  throw redirect(`/storefront/products/${encodeURIComponent(currentHandle)}${url.search}`, {
    status: 301,
    headers: { "Cache-Control": "public, max-age=300" },
  });
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const handle = params.handle ?? "";
  const shopId = await resolveStorefrontShop(request);
  // Designer-published shops (hidden Labs) serve their snapshot instead of
  // the runtime renderer; shops without a publication are untouched.
  const designer = await resolveDesignerPublicPage(shopId, { kind: "product", handle });
  if (designer) return json(designer.page, { headers: designer.headers });
  const runtime1 = await resolveRuntime1Route({ shopId, request, route: { kind: "product", handle } });
  if (!runtime1) throw new Response("Storefront is temporarily unavailable.", { status: 503 });
  if (runtime1.data.notFound) {
    await redirectRenamedProductHandle(request, shopId, handle);
    throw new Response(null, { status: 404 });
  }
  const nonce = randomBytes(18).toString("base64url");
  const headers = storefrontCacheHeaders({ routeId: "product", personalized: false, shopId });
  markStorefrontBundleRendered(headers, nonce);
  const title = runtime1.data.product?.title ?? "Product";
  appendStorefrontTrackingCookies(headers, await trackStorefrontEvent(request, shopId, "page_view", {
    productId: runtime1.data.product?.id ?? null,
  }));
  let seoMeta: MetaDescriptor[];
  try {
    const [product, settings] = await Promise.all([
      getCatalog().getProduct(shopId, handle),
      getStoreSettings(shopId),
    ]);
    if (!product) throw new Error("Product is missing from the public catalog.");
    const override = await getSeoOverride(shopId, "product", product.id);
    seoMeta = safeMetaFromDraft(applyOverride(
      buildProductDraft(product, settings, storefrontOrigin(request)),
      override,
    ));
  } catch (err) {
    console.error(`[storefront] seo meta build failed for shop ${shopId}:`, err);
    seoMeta = [{ title }];
  }
  return json({ ...runtime1, nonce, seoMeta }, { headers });
}

export async function action({ request }: ActionFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  // Browse-only guard: the demo shell can't own a cart row, so a crafted POST
  // must bounce back to the page instead of 500ing on the uuid-keyed insert.
  if (shopId === DEMO_SHOP_ID) {
    const url = new URL(request.url);
    return redirect(url.pathname);
  }
  // Throttle add-to-cart so a scripted client cannot mint unbounded cart/line rows.
  if (!(await rateLimit(clientIpKey(request, "cart-add"), 30, 60_000))) {
    throw new Response("Too many requests", { status: 429 });
  }
  // Validate at the boundary — never trust the FormData shape.
  const form = await request.formData();
  const variantId = form.get("variantId");
  if (typeof variantId !== "string" || variantId.length === 0) {
    throw new Response("variantId is required", { status: 400 });
  }

  // Reuse the buyer's existing cart when the cookie is present; otherwise mint one
  // and persist its id in the Set-Cookie carried back with the redirect.
  const cookieCartId = await readCartId(request);
  let cartId = cookieCartId;
  const headers = new Headers();
  if (!cartId) {
    cartId = (await buildCart(shopId)).id;
    headers.append("Set-Cookie", await commitCartId(cartId));
  }
  // addCartLine snapshots price/currency/title and increments on a repeat variant. A variant that
  // sold out / was archived while the PDP was open (or a stale/crafted variant id) throws
  // VariantUnavailableError — catch it and bounce back to the PDP with a friendly notice instead of
  // a raw 500. Any other error is a genuine fault and propagates.
  let line;
  try {
    line = await addCartLine(shopId, cartId, variantId, 1);
  } catch (err) {
    if (err instanceof VariantUnavailableError) {
      const url = new URL(request.url);
      return redirect(`${url.pathname}?unavailable=1`, { headers });
    }
    throw err;
  }

  // Record the owning PRODUCT id (not the variant id) so storefront_event.product_id
  // holds the same id kind that page_view writes — a variant id here would silently
  // break any product-level view->add funnel join.
  const track = await trackStorefrontEvent(request, shopId, "cart_add", {
    productId: line.productId,
    experimentId: null,
    variantKey: null,
  });
  appendStorefrontTrackingCookies(headers, track);

  // redirect after the mutation to avoid a double-submit on refresh.
  return redirect("/storefront/cart", { headers });
}

export default function StorefrontProduct() {
  const loaded = useLoaderData<typeof loader>();
  if (isDesignerPublicPage(loaded)) {
    return <DesignerPublicView page={loaded} />;
  }
  if (!isRuntime1RenderData(loaded)) throw new Error("Product data is unavailable.");
  return <>{renderStorefrontSurface({ bundle: loaded.bundle, routeId: "product", data: loaded.data, nonce: loaded.nonce, mode: "public", visualLayerPlacement: loaded.visualLayerPlacement })}<StorefrontHydrator bundle={loaded.bundle} routeId="product" data={loaded.data} mode="public" /></>;
}
