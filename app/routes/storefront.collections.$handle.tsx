// app/routes/storefront.collections.$handle.tsx
import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { resolveStorefrontShop } from "~/lib/storefront/shop.server";

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  const title = data ? `${data.title} — Calderyn Demo Store` : "Collection — Calderyn Demo Store";
  const description = data ? `Browse ${data.title} at the Calderyn Demo Store.` : "Browse this collection.";
  return [
    { title },
    { name: "description", content: description },
    { property: "og:title", content: title },
  ];
};

export async function loader({ request, params }: LoaderFunctionArgs) {
  const handle = params.handle ?? "";
  const shopId = await resolveStorefrontShop(request);
  const catalog = getCatalog();
  // Manual shop_id scoping: shopId is the first arg of every read.
  const products = await catalog.listProducts(shopId, { collection: handle });
  if (products.length === 0) throw new Response(null, { status: 404 });
  const collections = await catalog.listCollections(shopId);
  const title = collections.find((c) => c.handle === handle)?.title ?? handle;
  return json({ handle, title, products });
}

export default function StorefrontCollection() {
  const { title, products } = useLoaderData<typeof loader>();
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
                ? new Intl.NumberFormat(undefined, {
                    style: "currency",
                    currency: p.variants[0].currency,
                  }).format(p.variants[0].priceCents / 100)
                : ""}
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}
