// app/routes/storefront._index.tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { resolveStorefrontShop } from "~/lib/storefront/shop.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  const catalog = getCatalog();
  // Manual shop_id scoping: shopId is the first arg of every read.
  const [collections, products] = await Promise.all([
    catalog.listCollections(shopId),
    catalog.listProducts(shopId),
  ]);
  return json({ collections, products });
}

export default function StorefrontHome() {
  const { collections, products } = useLoaderData<typeof loader>();
  return (
    <div className="cd-store__home">
      <nav className="cd-store__nav">
        {collections.map((c) => (
          <a key={c.handle} href={`/storefront/collections/${c.handle}`}>
            {c.title}
          </a>
        ))}
      </nav>
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
