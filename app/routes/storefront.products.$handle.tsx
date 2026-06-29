// app/routes/storefront.products.$handle.tsx
import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { resolveStorefrontShop } from "~/lib/storefront/shop.server";

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  const title = data ? `${data.product.title} — Calderyn Demo Store` : "Product — Calderyn Demo Store";
  const description = data?.product.description || "Product detail.";
  return [
    { title },
    { name: "description", content: description },
    { property: "og:title", content: title },
  ];
};

export async function loader({ request, params }: LoaderFunctionArgs) {
  const handle = params.handle ?? "";
  const shopId = await resolveStorefrontShop(request);
  // Manual shop_id scoping: shopId is the first arg of the read.
  const product = await getCatalog().getProduct(shopId, handle);
  if (!product) throw new Response(null, { status: 404 });
  return json({ product });
}

export default function StorefrontProduct() {
  const { product } = useLoaderData<typeof loader>();
  return (
    <article className="cd-pdp">
      <div className="cd-pdp__gallery">
        {product.images.map((img, i) => (
          <img key={i} src={img.url} alt={img.alt ?? product.title} />
        ))}
      </div>
      <div className="cd-pdp__info">
        <h1>{product.title}</h1>
        <p>{product.description}</p>
        <ul className="cd-pdp__variants">
          {product.variants.map((v) => (
            <li key={v.id}>
              {v.title} —{" "}
              {new Intl.NumberFormat(undefined, { style: "currency", currency: v.currency }).format(
                v.priceCents / 100,
              )}
              {v.available ? "" : " (sold out)"}
            </li>
          ))}
        </ul>
        {/* Browse-only shell: Add to cart is intentionally inert (no handler, no
            form). Cart and checkout are separate modules. */}
        <button className="cd-pdp__buy" type="button">
          Add to cart
        </button>
      </div>
    </article>
  );
}
