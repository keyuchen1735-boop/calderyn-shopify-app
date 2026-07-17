// app/routes/storefront._index.tsx
import type { HeadersFunction, LoaderFunctionArgs, MetaDescriptor, MetaFunction } from "@remix-run/node";
import { resolveDesignerPublicPage } from "~/lib/designer/serve.server";
import DesignerPublicView from "~/components/storefront/DesignerPublicView";
import { isDesignerPublicPage } from "~/lib/designer/types";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { resolveStorefrontShop } from "~/lib/storefront/shop.server";
import { randomBytes } from "node:crypto";
import { resolveRuntime1Route } from "~/lib/storefront-runtime/release-resolution.server";
import { isRuntime1RenderData, renderStorefrontSurface } from "~/lib/storefront-runtime/render";
import { markStorefrontBundleRendered } from "~/lib/storefront-runtime/csp.server";
import { storefrontCacheHeaders } from "~/lib/storefront-runtime/cache.server";
import { StorefrontHydrator } from "~/lib/storefront-runtime/storefront-hydrator";
import { trackStorefrontEvent } from "~/lib/storefront/events.server";
import { appendStorefrontTrackingCookies } from "~/lib/storefront/visitor-cookie.server";
import { getStoreSettings } from "~/lib/storefront/settings.server";
import { getSeoSettings } from "~/lib/seo/seo-store.server";
import { buildHomeDraft } from "~/lib/seo/writer.server";
import { safeMetaFromDraft } from "~/lib/seo/render.server";
import { storefrontOrigin } from "~/lib/seo/origin.server";

export const meta: MetaFunction<typeof loader> = ({ data }) =>
  data && "seoMeta" in data ? data.seoMeta : [{ title: "Store" }];
export const headers: HeadersFunction = ({ loaderHeaders }) => loaderHeaders;

export async function loader({ request }: LoaderFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  // Designer-published shops (hidden Labs) serve their snapshot instead of
  // the runtime renderer; shops without a publication are untouched.
  const designer = await resolveDesignerPublicPage(shopId, { kind: "home" });
  if (designer) return json(designer.page, { headers: designer.headers });
  const runtime1 = await resolveRuntime1Route({ shopId, request, route: { kind: "home" } });
  if (runtime1) {
    const nonce = randomBytes(18).toString("base64url");
    const headers = storefrontCacheHeaders({ routeId: "home", personalized: false, shopId });
    markStorefrontBundleRendered(headers, nonce);
    appendStorefrontTrackingCookies(headers, await trackStorefrontEvent(request, shopId, "page_view"));
    let seoMeta: MetaDescriptor[];
    try {
      const [settings, seo] = await Promise.all([getStoreSettings(shopId), getSeoSettings(shopId)]);
      seoMeta = safeMetaFromDraft(buildHomeDraft(settings, storefrontOrigin(request)));
      if (seo.googleSiteVerification) {
        seoMeta.push({ name: "google-site-verification", content: seo.googleSiteVerification });
      }
    } catch (err) {
      console.error(`[storefront] seo meta build failed for shop ${shopId}:`, err);
      seoMeta = [{ title: runtime1.data.store.name }];
    }
    return json({ ...runtime1, nonce, seoMeta }, { headers });
  }
  throw new Response("Storefront is temporarily unavailable.", { status: 503 });
}

export default function StorefrontHome() {
  const loaded = useLoaderData<typeof loader>();
  if (isDesignerPublicPage(loaded)) {
    return <DesignerPublicView page={loaded} />;
  }
  if (!isRuntime1RenderData(loaded)) throw new Error("Storefront data is unavailable.");
  return <>{renderStorefrontSurface({ bundle: loaded.bundle, routeId: "home", data: loaded.data, nonce: loaded.nonce, mode: "public", visualLayerPlacement: loaded.visualLayerPlacement })}<StorefrontHydrator bundle={loaded.bundle} routeId="home" data={loaded.data} mode="public" /></>;
}
