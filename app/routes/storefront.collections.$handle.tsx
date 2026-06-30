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
  const products = await catalog.listProducts(shopId, { collection: handle });
  if (products.length === 0) throw new Response(null, { status: 404 });
  const collections = await catalog.listCollections(shopId);
  const title = collections.find((c) => c.handle === handle)?.title ?? handle;

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
        {products.map((p) => (
          <a key={p.id} className="cd-product-card" href={`/storefront/products/${p.handle}`}>
            {p.images[0] ? (
              <img className="cd-product-card__img" src={p.images[0].url} alt={p.images[0].alt ?? p.title} />
            ) : null}
            <span className="cd-product-card__title">{p.title}</span>
            <span className="cd-product-card__price">
              {p.variants[0]
                ? new Intl.NumberFormat(undefined, { style: "currency", currency: p.variants[0].currency }).format(
                    p.variants[0].priceCents / 100,
                  )
                : ""}
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}
