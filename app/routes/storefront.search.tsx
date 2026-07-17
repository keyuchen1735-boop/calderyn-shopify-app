import type { HeadersFunction, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { randomBytes } from "node:crypto";
import { resolveStorefrontShop } from "~/lib/storefront/shop.server";
import { hasRuntime1Storefront, resolveRuntime1Route } from "~/lib/storefront-runtime/release-resolution.server";
import { renderStorefrontSurface } from "~/lib/storefront-runtime/render";
import { markStorefrontBundleRendered } from "~/lib/storefront-runtime/csp.server";
import { storefrontCacheHeaders } from "~/lib/storefront-runtime/cache.server";
import { StorefrontHydrator } from "~/lib/storefront-runtime/storefront-hydrator";
import { InvalidSearchRequestError, parseStorefrontSearchParams } from "~/lib/storefront/search.server";
import { storefrontError } from "~/lib/storefront/cart-api.server";
import { resolveDesignerPublicPage } from "~/lib/designer/serve.server";
import DesignerPublicView from "~/components/storefront/DesignerPublicView";
import { isDesignerPublicPage } from "~/lib/designer/types";

export const meta: MetaFunction = () => [
  { title: "Search" },
  { name: "robots", content: "noindex" },
];
export const headers: HeadersFunction = ({ loaderHeaders }) => loaderHeaders;

export async function loader({ request }: LoaderFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  // Designer-published shops (hidden Labs) serve their snapshot instead.
  const designer = await resolveDesignerPublicPage(shopId, {
    kind: "search",
    query: new URL(request.url).searchParams.get("q") ?? "",
  });
  if (designer) return json(designer.page, { headers: designer.headers });
  let searchInput;
  try {
    searchInput = parseStorefrontSearchParams(new URL(request.url).searchParams);
  } catch (error) {
    if (error instanceof InvalidSearchRequestError) {
      throw await hasRuntime1Storefront({ shopId, request })
        ? storefrontError(422, "invalid_search_request")
        : new Response(null, { status: 404 });
    }
    throw error;
  }
  const runtime1 = await resolveRuntime1Route({
    shopId,
    request,
    route: { kind: "search", query: searchInput.query, searchInput },
  });
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
  if (isDesignerPublicPage(loaded)) {
    return <DesignerPublicView page={loaded} />;
  }
  return <>{renderStorefrontSurface({ bundle: loaded.bundle, routeId: "search", data: loaded.data, nonce: loaded.nonce, mode: "public" })}<StorefrontHydrator bundle={loaded.bundle} routeId="search" data={loaded.data} mode="public" /></>;
}
