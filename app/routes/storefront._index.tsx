// app/routes/storefront._index.tsx
import type { HeadersFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
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

export const meta: MetaFunction<typeof loader> = ({ data }) =>
  data && "seoMeta" in data ? data.seoMeta : [{ title: "Store" }];
export const headers: HeadersFunction = ({ loaderHeaders }) => loaderHeaders;

export async function loader({ request }: LoaderFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  const runtime1 = await resolveRuntime1Route({ shopId, request, route: { kind: "home" } });
  if (runtime1) {
    const nonce = randomBytes(18).toString("base64url");
    const headers = storefrontCacheHeaders({ routeId: "home", personalized: false, shopId });
    markStorefrontBundleRendered(headers, nonce);
    appendStorefrontTrackingCookies(headers, await trackStorefrontEvent(request, shopId, "page_view"));
    return json({ ...runtime1, nonce, seoMeta: [{ title: runtime1.data.store.name }] }, { headers });
  }
  throw new Response("No runtime-1 storefront release is available.", { status: 503 });
}

export default function StorefrontHome() {
  const loaded = useLoaderData<typeof loader>();
  if (!isRuntime1RenderData(loaded)) throw new Error("Runtime-1 storefront data is required.");
  return <>{renderStorefrontSurface({ bundle: loaded.bundle, routeId: "home", data: loaded.data, nonce: loaded.nonce, mode: "public", visualLayerPlacement: loaded.visualLayerPlacement })}<StorefrontHydrator bundle={loaded.bundle} routeId="home" data={loaded.data} mode="public" /></>;
}
