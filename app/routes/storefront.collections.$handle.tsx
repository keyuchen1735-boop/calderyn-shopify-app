// app/routes/storefront.collections.$handle.tsx
import type { HeadersFunction, LoaderFunctionArgs, MetaFunction, MetaDescriptor } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { resolveStorefrontShop } from "~/lib/storefront/shop.server";
import { trackStorefrontEvent } from "~/lib/storefront/events.server";
import { formatMoney } from "~/lib/storefront/money";
import { getStoreSettings } from "~/lib/storefront/settings.server";
import { buildCollectionDraft } from "~/lib/seo/writer.server";
import { safeMetaFromDraft } from "~/lib/seo/render.server";
import { storefrontOrigin } from "~/lib/seo/origin.server";
import { loadPublishedDoc } from "~/lib/storebuilder/page-document.server";
import { resolveRenderData } from "~/lib/storebuilder/resolve-data.server";
import { storefrontWeatherCondition } from "~/lib/storefront/weather-serve.server";
import { renderBlocks } from "~/lib/storebuilder/render";
import { resolveServedExperiment } from "~/lib/experiments/store-experiment.server";
import { randomBytes } from "node:crypto";
import { hasRuntime1Storefront, resolveRuntime1Route } from "~/lib/storefront-runtime/release-resolution.server";
import { isRuntime1RenderData, renderStorefrontSurface } from "~/lib/storefront-runtime/render";
import { markStorefrontBundleRendered } from "~/lib/storefront-runtime/csp.server";
import { storefrontCacheHeaders } from "~/lib/storefront-runtime/cache.server";
import { StorefrontHydrator } from "~/lib/storefront-runtime/storefront-hydrator";
import { InvalidSearchRequestError, parseStorefrontCollectionParams } from "~/lib/storefront/search.server";
import { storefrontError } from "~/lib/storefront/cart-api.server";

export const meta: MetaFunction<typeof loader> = ({ data }) => data?.seoMeta ?? [{ title: "Collection" }];
export const headers: HeadersFunction = ({ loaderHeaders }) => loaderHeaders;

export async function loader({ request, params }: LoaderFunctionArgs) {
  const handle = params.handle ?? "";
  const shopId = await resolveStorefrontShop(request);
  let runtime1: Awaited<ReturnType<typeof resolveRuntime1Route>> = null;
  if (await hasRuntime1Storefront({ shopId, request })) {
    try {
      const searchInput = parseStorefrontCollectionParams(new URL(request.url).searchParams, handle);
      runtime1 = await resolveRuntime1Route({ shopId, request, route: { kind: "collection", handle, searchInput } });
    } catch (error) {
      if (error instanceof InvalidSearchRequestError) throw storefrontError(422, "invalid_search_request");
      throw error;
    }
  }
  if (runtime1) {
    if (runtime1.data.notFound) throw new Response(null, { status: 404 });
    const nonce = randomBytes(18).toString("base64url");
    const headers = storefrontCacheHeaders({ routeId: "collection", personalized: false, shopId });
    markStorefrontBundleRendered(headers, nonce);
    const title = runtime1.data.collection?.title ?? "Collection";
    return json({ ...runtime1, nonce, seoMeta: [{ title }] }, { headers });
  }
  const catalog = getCatalog();
  // Manual shop_id scoping: shopId is the first arg of every read.
  const [collections, products] = await Promise.all([
    catalog.listCollections(shopId),
    catalog.listProducts(shopId, { collection: handle }),
  ]);
  // 404 only when the handle isn't a real collection. A real but empty collection
  // (all its products archived, or none assigned yet) renders an empty state rather
  // than a hard 404 that would break the shareable URL.
  const collection = collections.find((c) => c.handle === handle);
  if (!collection) throw new Response(null, { status: 404 });
  const title = collection.title;

  // Render the published collection TEMPLATE bound to this collection record. No doc → legacy grid.
  // A sitewide vibe experiment treats this page (the layout restyles every route), so its
  // exposure is measured here too — resolved concurrently with the doc read (independent).
  const [doc, exposure] = await Promise.all([
    loadPublishedDoc(shopId, "collection"),
    resolveServedExperiment(shopId, request, "collection"),
  ]);
  const record = { collection: { handle, title } };
  const weatherCondition = await storefrontWeatherCondition(request, shopId);
  const data = doc ? await resolveRenderData(doc, shopId, catalog, record, weatherCondition) : null;
  const track = await trackStorefrontEvent(request, shopId, "page_view", {
    experimentId: exposure.experimentId,
    variantKey: exposure.variantKey,
  });
  // SEO/AIO meta + CollectionPage JSON-LD. Failure-isolated (see the PDP/home routes):
  // a settings-fetch hiccup must never 500 a collection page that would otherwise render
  // fine. StoreCollection carries no description field today, so the writer always falls
  // back to its own "<title> from <store>" template. Collections have no merchant
  // override (only product overrides are written), so there is nothing to layer here.
  let seoMeta: MetaDescriptor[];
  try {
    const settings = await getStoreSettings(shopId);
    const draft = buildCollectionDraft({ handle, title, description: null }, settings, storefrontOrigin(request));
    seoMeta = safeMetaFromDraft(draft);
  } catch (err) {
    console.error(`[storefront] seo meta build failed for shop ${shopId}:`, err);
    seoMeta = [{ title }];
  }
  return json({ handle, title, products, doc, data, record, seoMeta }, { headers: track });
}

export default function StorefrontCollection() {
  const loaded = useLoaderData<typeof loader>();
  if (isRuntime1RenderData(loaded)) {
    return <>{renderStorefrontSurface({ bundle: loaded.bundle, routeId: "collection", data: loaded.data, nonce: loaded.nonce, mode: "public" })}<StorefrontHydrator bundle={loaded.bundle} routeId="collection" data={loaded.data} mode="public" /></>;
  }
  const { title, products, doc, data, record } = loaded;
  if (doc && data) {
    return <div className="cd-store__collection">{renderBlocks(doc, { data, record })}</div>;
  }
  return (
    <div className="cd-store__home">
      <h1>{title}</h1>
      <div className="cd-store__grid">
        {products.map((p) => {
          // Price the card off the first buyable variant; a product whose variants
          // are all unpriced shows no price rather than a misleading "$0.00".
          const priced = p.variants.find((v) => v.available);
          return (
            <a key={p.id} className="cd-product-card" href={`/storefront/products/${p.handle}`}>
              {p.images[0] ? (
                <img className="cd-product-card__img" src={p.images[0].url} alt={p.images[0].alt ?? p.title} />
              ) : null}
              <span className="cd-product-card__title">{p.title}</span>
              <span className="cd-product-card__price">
                {priced ? formatMoney(priced.priceCents, priced.currency) : ""}
              </span>
            </a>
          );
        })}
      </div>
    </div>
  );
}
