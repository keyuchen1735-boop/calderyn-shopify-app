// app/routes/storefront.products.$handle.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import { useState } from "react";
import { DeliveryPromise } from "~/components/storefront/DeliveryPromise";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { resolveStorefrontShop, DEMO_SHOP_ID } from "~/lib/storefront/shop.server";
import { readCartId, commitCartId } from "~/lib/storefront/cart-cookie.server";
import { trackStorefrontEvent } from "~/lib/storefront/events.server";
import { buildCart, addCartLine } from "~/lib/order/cart.server";
import { formatMoney } from "~/lib/storefront/money";
import { storeNameFromMatches } from "~/lib/storefront/meta";
import { loadPublishedDoc } from "~/lib/storebuilder/page-document.server";
import { resolveRenderData } from "~/lib/storebuilder/resolve-data.server";
import { renderBlocks } from "~/lib/storebuilder/render";

export const meta: MetaFunction<typeof loader> = ({ data, matches }) => {
  const store = storeNameFromMatches(matches);
  const title = data ? `${data.product.title} — ${store}` : `Product — ${store}`;
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
  const catalog = getCatalog();
  const product = await catalog.getProduct(shopId, handle);
  if (!product) throw new Response(null, { status: 404 });
  // Render the published PDP TEMPLATE bound to this product record. No doc → legacy PDP markup.
  const doc = await loadPublishedDoc(shopId, "pdp");
  const record = { product };
  const data = doc ? await resolveRenderData(doc, shopId, catalog, record) : null;
  const track = await trackStorefrontEvent(request, shopId, "page_view", {
    productId: product.id,
  });
  // The demo shell has no shop row behind it, so carts (uuid shop_id) can't exist
  // for it — the PDP renders browse-only instead of offering a cart that 500s.
  return json({ product, doc, data, record, demo: shopId === DEMO_SHOP_ID }, { headers: track });
}

export async function action({ request }: ActionFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  // Browse-only guard: the demo shell can't own a cart row, so a crafted POST
  // must bounce back to the page instead of 500ing on the uuid-keyed insert.
  if (shopId === DEMO_SHOP_ID) {
    const url = new URL(request.url);
    return redirect(url.pathname);
  }
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

  const track = await trackStorefrontEvent(request, shopId, "cart_add", {
    productId: variantId,
  });
  for (const c of track.getSetCookie()) headers.append("Set-Cookie", c);

  // redirect after the mutation to avoid a double-submit on refresh.
  return redirect("/storefront/cart", { headers });
}

export default function StorefrontProduct() {
  const { product, doc, data, record, demo } = useLoaderData<typeof loader>();
  const firstVariantId = product.variants[0]?.id ?? "";
  const [selectedVariantId, setSelectedVariantId] = useState(firstVariantId);

  // NOTE: a published template renders its own addToCart block even for the demo
  // shell (the template testbed) — the action's DEMO_SHOP_ID guard keeps that
  // POST a safe no-op redirect rather than a uuid-cast 500.
  if (doc && data) {
    // The addToCart block renders a native <form method="post"> posting to THIS route's action.
    return (
      <article className="cd-pdp cd-pdp--blocks">
        {renderBlocks(doc, { data, record })}
        {firstVariantId && <DeliveryPromise variantId={firstVariantId} />}
      </article>
    );
  }
  const buyable = product.variants.filter((v) => v.available);
  const activeVariantId = selectedVariantId || buyable[0]?.id || firstVariantId;
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
              {v.title} — {formatMoney(v.priceCents, v.currency)}
              {v.available ? "" : " (sold out)"}
            </li>
          ))}
        </ul>
        {demo ? (
          <button className="cd-pdp__buy" type="button" disabled>
            Demo store — browsing only
          </button>
        ) : buyable.length > 0 ? (
          <Form method="post" className="cd-pdp__add">
            {buyable.length > 1 ? (
              <select
                name="variantId"
                className="cd-pdp__variant-select"
                aria-label="Choose an option"
                value={activeVariantId}
                onChange={(e) => setSelectedVariantId(e.target.value)}
              >
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
        {activeVariantId && <DeliveryPromise variantId={activeVariantId} />}
      </div>
    </article>
  );
}
