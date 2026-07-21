import type { HeadersFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { randomBytes } from "node:crypto";
import { resolveStorefrontShop } from "~/lib/storefront/shop.server";
import { resolveRuntime1Route } from "~/lib/storefront-runtime/release-resolution.server";
import { renderStorefrontSurface } from "~/lib/storefront-runtime/render";
import { StorefrontHydrator } from "~/lib/storefront-runtime/storefront-hydrator";
import { markStorefrontBundleRendered } from "~/lib/storefront-runtime/csp.server";
import { storefrontCacheHeaders } from "~/lib/storefront-runtime/cache.server";

export const meta: MetaFunction = () => [{ title: "Page not found" }, { name: "robots", content: "noindex" }];
export const headers: HeadersFunction = ({ loaderHeaders }) => loaderHeaders;

export async function loader({ request }: LoaderFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  const runtime1 = await resolveRuntime1Route({ shopId, request, route: { kind: "notFound" } });
  if (!runtime1) throw new Response("Storefront is temporarily unavailable.", { status: 503 });
  const nonce = randomBytes(18).toString("base64url");
  const responseHeaders = storefrontCacheHeaders({ routeId: "notFound", personalized: false, shopId });
  markStorefrontBundleRendered(responseHeaders, nonce);
  return json({ ...runtime1, nonce }, { status: 404, headers: responseHeaders });
}

export default function StorefrontNotFound() {
  const loaded = useLoaderData<typeof loader>();
  if (loaded.routeId !== "notFound") return <main data-cd-platform-error="not-found"><h1>Page not found</h1><p>The requested page is unavailable.</p></main>;
  return <>{renderStorefrontSurface({ bundle: loaded.bundle, routeId: "notFound", data: loaded.data, nonce: loaded.nonce, mode: "public", visualLayerPlacement: loaded.visualLayerPlacement })}<StorefrontHydrator bundle={loaded.bundle} routeId="notFound" data={loaded.data} mode="public" /></>;
}
