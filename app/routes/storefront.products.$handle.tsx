// app/routes/storefront.products.$handle.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction, MetaDescriptor } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import { useState } from "react";
import { DeliveryPromise } from "~/components/storefront/DeliveryPromise";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { resolveStorefrontShop, DEMO_SHOP_ID } from "~/lib/storefront/shop.server";
import { readCartId, commitCartId } from "~/lib/storefront/cart-cookie.server";
import { trackStorefrontEvent } from "~/lib/storefront/events.server";
import { buildCart, addCartLine, VariantUnavailableError } from "~/lib/order/cart.server";
import { rateLimit, clientIpKey } from "~/lib/rate-limit.server";
import { formatMoney } from "~/lib/storefront/money";
import { getStoreSettings } from "~/lib/storefront/settings.server";
import { buildProductDraft } from "~/lib/seo/writer.server";
import { safeMetaFromDraft } from "~/lib/seo/render.server";
import { storefrontOrigin } from "~/lib/seo/origin.server";
import { getSeoOverride } from "~/lib/seo/seo-store.server";
import { applyOverride } from "~/lib/seo/override";
import { loadPublishedDoc } from "~/lib/storebuilder/page-document.server";
import { resolveRenderData } from "~/lib/storebuilder/resolve-data.server";
import { storefrontWeatherCondition } from "~/lib/storefront/weather-serve.server";
import { renderBlocks } from "~/lib/storebuilder/render";
import { resolveServedExperiment } from "~/lib/experiments/store-experiment.server";
import type { Block } from "~/lib/storebuilder/types";

export const meta: MetaFunction<typeof loader> = ({ data }) => data?.seoMeta ?? [{ title: "Product" }];

export async function loader({ request, params }: LoaderFunctionArgs) {
  const handle = params.handle ?? "";
  const shopId = await resolveStorefrontShop(request);
  const catalog = getCatalog();
  const product = await catalog.getProduct(shopId, handle);
  if (!product) throw new Response(null, { status: 404 });
  // Render the published PDP TEMPLATE bound to this product record. No doc → legacy PDP markup.
  // A/B participation (pdp experiments serve their variant to arm B here; sitewide vibe tests
  // are measured here too) resolves through the shared experiments helper — one bucketing rule
  // across every storefront surface.
  const [published, experiment] = await Promise.all([
    loadPublishedDoc(shopId, "pdp"),
    resolveServedExperiment(shopId, request, "pdp"),
  ]);
  const doc =
    experiment.variantKey === "b" && experiment.experiment?.pageKey === "pdp"
      ? experiment.experiment.variantDoc
      : published;
  const record = { product };
  const weatherCondition = await storefrontWeatherCondition(request, shopId);
  const data = doc ? await resolveRenderData(doc, shopId, catalog, record, weatherCondition) : null;
  const track = await trackStorefrontEvent(request, shopId, "page_view", {
    productId: product.id,
    experimentId: experiment.experimentId,
    variantKey: experiment.variantKey,
  });
  // SEO/AIO meta + Product JSON-LD, computed server-side so it is present on first paint.
  // Failure-isolated (mirrors the storefront layout's own settings/experiment reads): a
  // settings-fetch hiccup must never 500 a PDP that would otherwise render fine.
  let seoMeta: MetaDescriptor[];
  try {
    const settings = await getStoreSettings(shopId);
    const draft = buildProductDraft(product, settings, storefrontOrigin(request));
    const override = await getSeoOverride(shopId, "product", product.id);
    seoMeta = safeMetaFromDraft(applyOverride(draft, override));
  } catch (err) {
    console.error(`[storefront] seo meta build failed for shop ${shopId}:`, err);
    seoMeta = [{ title: product.title }];
  }
  // `unavailable` is set when the add-to-cart action bounced back here because the variant sold out
  // / was archived (read from the URL in the loader, not useSearchParams, so a static render without
  // a Router context still works). The demo shell has no shop row behind it, so carts (uuid shop_id)
  // can't exist for it — the PDP renders browse-only instead of offering a cart that 500s.
  const unavailable = new URL(request.url).searchParams.get("unavailable") === "1";
  return json({ product, doc, data, record, demo: shopId === DEMO_SHOP_ID, seoMeta, unavailable }, { headers: track });
}

export async function action({ request }: ActionFunctionArgs) {
  const shopId = await resolveStorefrontShop(request);
  // Browse-only guard: the demo shell can't own a cart row, so a crafted POST
  // must bounce back to the page instead of 500ing on the uuid-keyed insert.
  if (shopId === DEMO_SHOP_ID) {
    const url = new URL(request.url);
    return redirect(url.pathname);
  }
  // Throttle add-to-cart so a scripted client cannot mint unbounded cart/line rows.
  if (!(await rateLimit(clientIpKey(request, "cart-add"), 30, 60_000))) {
    throw new Response("Too many requests", { status: 429 });
  }
  // Validate at the boundary — never trust the FormData shape.
  const form = await request.formData();
  const variantId = form.get("variantId");
  if (typeof variantId !== "string" || variantId.length === 0) {
    throw new Response("variantId is required", { status: 400 });
  }

  // Reuse the buyer's existing cart when the cookie is present; otherwise mint one
  // and persist its id in the Set-Cookie carried back with the redirect. The
  // experiment lookup is independent of the cookie read (checkout surface: every
  // running test measures its cart_add step), so the two resolve concurrently.
  const [cookieCartId, served] = await Promise.all([
    readCartId(request),
    resolveServedExperiment(shopId, request, "checkout"),
  ]);
  let cartId = cookieCartId;
  const headers = new Headers();
  if (!cartId) {
    cartId = (await buildCart(shopId)).id;
    headers.append("Set-Cookie", await commitCartId(cartId));
  }
  // addCartLine snapshots price/currency/title and increments on a repeat variant. A variant that
  // sold out / was archived while the PDP was open (or a stale/crafted variant id) throws
  // VariantUnavailableError — catch it and bounce back to the PDP with a friendly notice instead of
  // a raw 500. Any other error is a genuine fault and propagates.
  let line;
  try {
    line = await addCartLine(shopId, cartId, variantId, 1);
  } catch (err) {
    if (err instanceof VariantUnavailableError) {
      const url = new URL(request.url);
      return redirect(`${url.pathname}?unavailable=1`, { headers });
    }
    throw err;
  }

  // Record the owning PRODUCT id (not the variant id) so storefront_event.product_id
  // holds the same id kind that page_view writes — a variant id here would silently
  // break any product-level view->add funnel join.
  const track = await trackStorefrontEvent(request, shopId, "cart_add", {
    productId: line.productId,
    experimentId: served.experimentId,
    variantKey: served.variantKey,
  });
  for (const c of track.getSetCookie()) headers.append("Set-Cookie", c);

  // redirect after the mutation to avoid a double-submit on refresh.
  return redirect("/storefront/cart", { headers });
}

export default function StorefrontProduct() {
  const { product, doc, data, record, demo, unavailable } = useLoaderData<typeof loader>();
  const firstVariantId = product.variants[0]?.id ?? "";
  const [selectedVariantId, setSelectedVariantId] = useState(firstVariantId);

  // NOTE: a published template renders its own addToCart block even for the demo
  // shell (the template testbed) — the action's DEMO_SHOP_ID guard keeps that
  // POST a safe no-op redirect rather than a uuid-cast 500.
  if (doc && data) {
    // The addToCart block renders a native <form method="post"> posting to THIS route's action.
    // .cd-pdp is a two-column grid; without explicit columns the doc's blocks auto-place into it
    // and zigzag (title next to gallery, price under the gallery, add-to-cart orphaned). Compose
    // the layout the doc actually encodes: half-width blocks bucket into left (x<6) and right
    // (x>=6) columns; full-width blocks (w>6, e.g. a below-the-fold featureRow) span both
    // columns, before or after the column pair by their y position.
    const sorted: Block[] = [...doc.blocks].sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x);
    const left = sorted.filter((b) => b.layout.w <= 6 && b.layout.x < 6);
    const right = sorted.filter((b) => b.layout.w <= 6 && b.layout.x >= 6);
    const columnTopY = Math.min(...[...left, ...right].map((b) => b.layout.y), Infinity);
    const fullAbove = sorted.filter((b) => b.layout.w > 6 && b.layout.y < columnTopY);
    const fullBelow = sorted.filter((b) => b.layout.w > 6 && b.layout.y >= columnTopY);
    const sub = (blocks: Block[]) => renderBlocks({ ...doc, blocks }, { data, record });
    return (
      <article className="cd-pdp cd-pdp--blocks">
        {fullAbove.length > 0 ? <div className="cd-pdp__col cd-pdp__col--full">{sub(fullAbove)}</div> : null}
        {left.length > 0 ? <div className="cd-pdp__col">{sub(left)}</div> : null}
        <div className={left.length > 0 ? "cd-pdp__col" : "cd-pdp__col cd-pdp__col--full"}>
          {sub(right)}
          {firstVariantId && <DeliveryPromise variantId={firstVariantId} />}
        </div>
        {fullBelow.length > 0 ? <div className="cd-pdp__col cd-pdp__col--full">{sub(fullBelow)}</div> : null}
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
        {unavailable ? (
          <p className="cd-pdp__notice" role="status">
            Sorry, that item just sold out. Please choose another option.
          </p>
        ) : null}
        <p>{product.description}</p>
        <ul className="cd-pdp__variants">
          {product.variants.map((v) => (
            <li key={v.id}>
              {v.title} —{" "}
              {v.compareAtPriceCents != null && v.compareAtPriceCents > v.priceCents ? (
                <>
                  <s>{formatMoney(v.compareAtPriceCents, v.currency)}</s>{" "}
                </>
              ) : null}
              {formatMoney(v.priceCents, v.currency)}
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
