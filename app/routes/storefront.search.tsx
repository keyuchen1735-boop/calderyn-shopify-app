import type { HeadersFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { randomBytes } from "node:crypto";
import { resolveStorefrontShop } from "~/lib/storefront/shop.server";
import { resolveRuntime1Route } from "~/lib/storefront-runtime/release-resolution.server";
import { renderStorefrontSurface } from "~/lib/storefront-runtime/render";
import { markStorefrontBundleRendered } from "~/lib/storefront-runtime/csp.server";
import { storefrontCacheHeaders } from "~/lib/storefront-runtime/cache.server";
import { StorefrontHydrator } from "~/lib/storefront-runtime/storefront-hydrator";

export const meta: MetaFunction = () => [
  { title: "Search" },
  { name: "robots", content: "noindex" },
];
export const headers: HeadersFunction = ({ loaderHeaders }) => loaderHeaders;

export async function loader({ request }: LoaderFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  const query = new URL(request.url).searchParams.get("q")?.slice(0, 200) ?? "";
  const runtime1 = await resolveRuntime1Route({ shopId, route: { kind: "search", query } });
  if (runtime1) {
    const nonce = randomBytes(18).toString("base64url");
    const headers = storefrontCacheHeaders({ routeId: "search", personalized: true });
    markStorefrontBundleRendered(headers, nonce);
    return json({ ...runtime1, nonce }, { headers });
  }
  throw new Response(null, { status: 404 });
}

export default function StorefrontSearch() {
  const loaded = useLoaderData<typeof loader>();
  return <>{renderStorefrontSurface({ bundle: loaded.bundle, routeId: "search", data: loaded.data, nonce: loaded.nonce, mode: "public" })}<StorefrontHydrator bundle={loaded.bundle} routeId="search" data={loaded.data} mode="public" /></>;
}
