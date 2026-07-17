// Serves a shop's PUBLISHED designer pages on the public storefront. Absent
// publication rows mean the caller falls through to the runtime renderer, so
// shops that never touched the designer are completely unaffected.
//
// The page ships as loader DATA (body html + css + a nonce'd cart script) that
// the route component renders bare — the same shape runtime-1 uses — and the
// CSP rides the same header markers, so the one script allowed is ours.
import { randomBytes } from "node:crypto";
import { getSupabase } from "~/lib/supabase.server";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { getStoreSettings } from "~/lib/storefront/settings.server";
import { storefrontCacheHeaders } from "~/lib/storefront-runtime/cache.server";
import { markStorefrontBundleRendered } from "~/lib/storefront-runtime/csp.server";
import { renderDesignerBody } from "./render.server";
import { loadDesignerAssets } from "./imagery.server";
import { CART_DRAWER_CSS, CART_DRAWER_MARKUP, CART_DRAWER_SCRIPT } from "./widgets";
import type { DesignerPublicPage, DesignerStoreData } from "./types";

export type DesignerPublicContext =
  | { kind: "home" }
  | { kind: "product"; handle: string }
  | { kind: "collection"; handle: string }
  | { kind: "search"; query: string };

// Runtime-owned cart chrome (never model-authored): the drawer markup, its
// styling, and the script that wires add-to-cart into it live in widgets.ts.

const ROUTE_FOR_KIND = { home: "home", product: "product", collection: "collection", search: "search" } as const;
const PRODUCT_LIMIT = 12;

async function loadPublication(shopId: string, route: "home" | "collection" | "product" | "search") {
  const { data, error } = await getSupabase()
    .from("designer_publications")
    .select("route, html, css")
    .eq("shop_id", shopId)
    .in("route", ["base", route]);
  if (error) throw error;
  const base = data?.find((row) => row.route === "base");
  const page = data?.find((row) => row.route === route);
  return page ? { baseCss: String(base?.css ?? ""), html: String(page.html), css: String(page.css) } : null;
}

async function storeDataFor(
  shopId: string,
  context: DesignerPublicContext,
): Promise<(DesignerStoreData & { contextVariantId: string | null }) | null> {
  const catalog = getCatalog();
  const [settings, assets] = await Promise.all([getStoreSettings(shopId), loadDesignerAssets(shopId)]);
  const toProduct = (p: Awaited<ReturnType<typeof catalog.listProducts>>[number]) => ({
    id: p.id,
    handle: p.handle,
    title: p.title,
    description: p.description || null,
    priceCents: p.variants[0]?.priceCents ?? null,
    compareAtPriceCents: p.variants[0]?.compareAtPriceCents ?? null,
    available: true,
    imageUrl: p.images[0]?.url ?? null,
  });

  if (context.kind === "product") {
    const product = await catalog.getProduct(shopId, context.handle);
    if (!product) return null; // unknown handle → the runtime's 404 handling runs
    const rest = (await catalog.listProducts(shopId, { limit: PRODUCT_LIMIT })).filter((p) => p.id !== product.id);
    return {
      storeName: settings.storeName,
      assets,
      tagline: settings.voiceTagline,
      logoUrl: settings.logoUrl,
      products: [product, ...rest].map(toProduct),
      contextVariantId: product.variants[0]?.id ?? null,
    };
  }
  const options =
    context.kind === "collection" ? { collection: context.handle, limit: PRODUCT_LIMIT }
    : context.kind === "search" ? { query: context.query, limit: PRODUCT_LIMIT }
    : { limit: PRODUCT_LIMIT };
  const products = await catalog.listProducts(shopId, options);
  return {
    storeName: settings.storeName,
    assets,
    tagline: settings.voiceTagline,
    logoUrl: settings.logoUrl,
    products: products.map(toProduct),
    contextVariantId: products[0]?.variants[0]?.id ?? null,
  };
}

/** Loader payload + headers for the published designer page, or null when the
 *  shop has no publication (caller falls through to the runtime renderer). */
export async function resolveDesignerPublicPage(
  shopId: string,
  context: DesignerPublicContext,
): Promise<{ page: DesignerPublicPage; headers: Headers } | null> {
  const publication = await loadPublication(shopId, ROUTE_FOR_KIND[context.kind]).catch((err) => {
    // A read hiccup must never take the storefront down — fall through.
    console.error("[designer/serve] publication lookup failed", err);
    return null;
  });
  if (!publication) return null;

  const data = await storeDataFor(shopId, context);
  if (!data) return null;

  const rendered = renderDesignerBody({
    html: publication.html,
    css: `${publication.baseCss}\n${publication.css}`,
    data,
  });
  // Attach the context product's variant to add-to-cart buttons so the cart
  // script has something real to add. Server-owned post-processing.
  let bodyHtml = rendered.bodyHtml;
  if (data.contextVariantId) {
    bodyHtml = bodyHtml.replace(
      /class="designer-add-to-cart"/g,
      `class="designer-add-to-cart" data-variant-id="${data.contextVariantId}"`,
    );
  }
  // The cart drawer is always live chrome; the coupon widget's behavior only
  // when the page declared one (rendered.widgetScript is empty otherwise).
  bodyHtml = `${bodyHtml}\n${CART_DRAWER_MARKUP}`;
  const runtimeScript = `${CART_DRAWER_SCRIPT}\n${rendered.widgetScript}`;
  const nonce = randomBytes(18).toString("base64url");
  const headers = storefrontCacheHeaders({ routeId: ROUTE_FOR_KIND[context.kind], personalized: false, shopId });
  headers.set("cache-control", "no-store");
  markStorefrontBundleRendered(headers, nonce);
  return {
    page: {
      designer: true,
      bodyHtml,
      css: `${rendered.css}\n${CART_DRAWER_CSS}`,
      nonce,
      cartScript: runtimeScript,
      seoMeta: [{ title: data.storeName }],
    },
    headers,
  };
}
