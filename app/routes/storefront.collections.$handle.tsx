// app/routes/storefront.collections.$handle.tsx
import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { resolveStorefrontShop } from "~/lib/storefront/shop.server";
import { loadPublishedDoc } from "~/lib/storebuilder/page-document.server";
import { resolveRenderData } from "~/lib/storebuilder/resolve-data.server";
import { renderBlocks } from "~/lib/storebuilder/render";

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  const title = data ? `${data.title} — Calderyn Demo Store` : "Collection — Calderyn Demo Store";
  return [
    { title },
    { name: "description", content: data ? `Browse ${data.title} at the Calderyn Demo Store.` : "Browse this collection." },
    { property: "og:title", content: title },
  ];
};

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
  const doc = await loadPublishedDoc(shopId, "collection");
  const record = { collection: { handle, title } };
  const data = doc ? await resolveRenderData(doc, shopId, catalog, record) : null;
  return json({ handle, title, products, doc, data, record });
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
                {priced
                  ? new Intl.NumberFormat(undefined, {
                      style: "currency",
                      currency: priced.currency,
                    }).format(priced.priceCents / 100)
                  : ""}
              </span>
            </a>
          );
        })}
      </div>
    </div>
  );
}
