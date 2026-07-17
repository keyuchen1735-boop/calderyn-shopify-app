// app/routes/storefront.collections.$handle.tsx
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
import { InvalidSearchRequestError, parseStorefrontCollectionParams } from "~/lib/storefront/search.server";
import { storefrontError } from "~/lib/storefront/cart-api.server";
import { trackStorefrontEvent } from "~/lib/storefront/events.server";
import { appendStorefrontTrackingCookies } from "~/lib/storefront/visitor-cookie.server";

export const meta: MetaFunction<typeof loader> = ({ data }) => data?.seoMeta ?? [{ title: "Collection" }];
export const headers: HeadersFunction = ({ loaderHeaders }) => loaderHeaders;

function nextPageHref(request: Request, cursor: string | null): string | null {
  if (!cursor) return null;
  const url = new URL(request.url);
  url.searchParams.set("cursor", cursor);
  return `${url.pathname}?${url.searchParams.toString()}`;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const handle = params.handle ?? "";
  const shopId = await resolveStorefrontShop(request);
  let runtime1;
  try {
    const searchInput = parseStorefrontCollectionParams(new URL(request.url).searchParams, handle);
    runtime1 = await resolveRuntime1Route({ shopId, request, route: { kind: "collection", handle, searchInput } });
  } catch (error) {
    if (error instanceof InvalidSearchRequestError) throw storefrontError(422, "invalid_search_request");
    throw error;
  }
  if (!runtime1) throw new Response("No runtime-1 storefront release is available.", { status: 503 });
  if (runtime1.data.notFound) throw new Response(null, { status: 404 });
  const nonce = randomBytes(18).toString("base64url");
  const headers = storefrontCacheHeaders({ routeId: "collection", personalized: false, shopId });
  markStorefrontBundleRendered(headers, nonce);
  const title = runtime1.data.collection?.title ?? "Collection";
  appendStorefrontTrackingCookies(headers, await trackStorefrontEvent(request, shopId, "page_view"));
  return json({
    ...runtime1,
    nonce,
    nextPageHref: nextPageHref(request, runtime1.data.collection?.nextCursor ?? null),
    seoMeta: [{ title }],
  }, { headers });
}

function CollectionNextPage({ href }: { href: string | null }) {
  return href ? <a className="cd-store__pagination" rel="next" href={href}>Next products</a> : null;
}

export default function StorefrontCollection() {
  const loaded = useLoaderData<typeof loader>();
  if (!isRuntime1RenderData(loaded)) throw new Error("Runtime-1 collection data is required.");
  return <>{renderStorefrontSurface({ bundle: loaded.bundle, routeId: "collection", data: loaded.data, nonce: loaded.nonce, mode: "public", visualLayerPlacement: loaded.visualLayerPlacement })}<StorefrontHydrator bundle={loaded.bundle} routeId="collection" data={loaded.data} mode="public" /><CollectionNextPage href={loaded.nextPageHref} /></>;
}
