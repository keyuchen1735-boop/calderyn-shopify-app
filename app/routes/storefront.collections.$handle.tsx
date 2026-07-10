// app/routes/storefront.collections.$handle.tsx
import type { LoaderFunctionArgs, MetaFunction, MetaDescriptor } from "@remix-run/node";
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

export const meta: MetaFunction<typeof loader> = ({ data }) => data?.seoMeta ?? [{ title: "Collection" }];

export async function loader({ request, params }: LoaderFunctionArgs) {
  const handle = params.handle ?? "";
  const shopId = await resolveStorefrontShop(request);
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
  const { title, products, doc, data, record } = useLoaderData<typeof loader>();
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
