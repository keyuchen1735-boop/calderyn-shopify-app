// app/routes/storefront.products.$handle.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { resolveStorefrontShop } from "~/lib/storefront/shop.server";
import { readCartId, commitCartId } from "~/lib/storefront/cart-cookie.server";
import { buildCart, addCartLine } from "~/lib/order/cart.server";

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

export async function action({ request }: ActionFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  // Validate at the boundary — never trust the FormData shape.
  const form = await request.formData();
  const variantId = form.get("variantId");
  if (typeof variantId !== "string" || variantId.length === 0) {
    throw new Response("variantId is required", { status: 400 });
  }

  // Reuse the buyer's existing cart when the cookie is present; otherwise mint one
  // and persist its id in the Set-Cookie carried back with the redirect.
  let cartId = await readCartId(request);
  const headers = new Headers();
  if (!cartId) {
    cartId = (await buildCart(shopId)).id;
    headers.append("Set-Cookie", await commitCartId(cartId));
  }
  // addCartLine snapshots price/currency/title and increments on a repeat variant.
  await addCartLine(shopId, cartId, variantId, 1);

  // redirect after the mutation to avoid a double-submit on refresh.
  return redirect("/storefront/cart", { headers });
}

export default function StorefrontProduct() {
  const { product } = useLoaderData<typeof loader>();
  const buyable = product.variants.filter((v) => v.available);
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
        {buyable.length > 0 ? (
          <Form method="post" className="cd-pdp__add">
            {buyable.length > 1 ? (
              <select name="variantId" className="cd-pdp__variant-select" aria-label="Choose an option">
                {buyable.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.title}
                  </option>
                ))}
              </select>
            ) : (
              <input type="hidden" name="variantId" value={buyable[0].id} />
            )}
            <button className="cd-pdp__buy" type="submit">
              Add to cart
            </button>
          </Form>
        ) : (
          <button className="cd-pdp__buy" type="button" disabled>
            Sold out
          </button>
        )}
      </div>
    </article>
  );
}
