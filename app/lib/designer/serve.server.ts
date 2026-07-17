// Serves a shop's PUBLISHED designer pages on the public storefront. Absent
// publication rows mean the caller falls through to the runtime renderer, so
// shops that never touched the designer are completely unaffected.
//
// Safety on the live page mirrors the preview: the stored documents were
// scrubbed on save (no scripts, no external references), and the response CSP
// only allows the single runtime-owned cart script below via nonce.
import { randomBytes } from "node:crypto";
import { getSupabase } from "~/lib/supabase.server";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { getStoreSettings } from "~/lib/storefront/settings.server";
import { renderDesignerDocument } from "./render.server";
import type { DesignerStoreData } from "./types";

export type DesignerPublicContext =
  | { kind: "home" }
  | { kind: "product"; handle: string }
  | { kind: "collection"; handle: string }
  | { kind: "search"; query: string };

/** Runtime-owned (never model-authored): wires the designer's add-to-cart
 *  buttons to the real cart API, then hands off to the functional cart page. */
const CART_SCRIPT = `document.addEventListener("click",async function(e){var b=e.target&&e.target.closest?e.target.closest(".designer-add-to-cart"):null;if(!b)return;e.preventDefault();var v=b.getAttribute("data-variant-id");if(!v){location.href="/storefront/cart";return}b.disabled=true;try{var r=await fetch("/storefront/api/cart/add",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({variantId:v,quantity:1})});location.href=r.ok?"/storefront/cart":location.pathname}finally{b.disabled=false}});`;

function liveCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

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

const PRODUCT_LIMIT = 12;

async function storeDataFor(shopId: string, context: DesignerPublicContext): Promise<DesignerStoreData | null> {
  const catalog = getCatalog();
  const settings = await getStoreSettings(shopId);
  const toProduct = (p: Awaited<ReturnType<typeof catalog.listProducts>>[number]) => ({
    id: p.id,
    handle: p.handle,
    title: p.title,
    description: p.description || null,
    priceCents: p.variants[0]?.priceCents ?? null,
    compareAtPriceCents: p.variants[0]?.compareAtPriceCents ?? null,
    available: true,
    imageUrl: p.images[0]?.url ?? null,
    variantId: p.variants[0]?.id ?? null,
  });

  if (context.kind === "product") {
    const product = await catalog.getProduct(shopId, context.handle);
    if (!product) return null; // unknown handle → let the runtime 404 properly
    const rest = (await catalog.listProducts(shopId, { limit: PRODUCT_LIMIT })).filter((p) => p.id !== product.id);
    return {
      storeName: settings.storeName,
      tagline: settings.voiceTagline,
      logoUrl: settings.logoUrl,
      products: [product, ...rest].map(toProduct),
    };
  }
  const options =
    context.kind === "collection" ? { collection: context.handle, limit: PRODUCT_LIMIT }
    : context.kind === "search" ? { query: context.query, limit: PRODUCT_LIMIT }
    : { limit: PRODUCT_LIMIT };
  const products = await catalog.listProducts(shopId, options);
  return {
    storeName: settings.storeName,
    tagline: settings.voiceTagline,
    logoUrl: settings.logoUrl,
    products: products.map(toProduct),
  };
}

/** Renders the published designer page for this context, or null when the shop
 *  has no publication (caller falls through to the runtime renderer). */
export async function serveDesignerPageIfPublished(
  shopId: string,
  context: DesignerPublicContext,
): Promise<Response | null> {
  const publication = await loadPublication(shopId, context.kind).catch((err) => {
    // A read hiccup must never take the storefront down — fall through.
    console.error("[designer/serve] publication lookup failed", err);
    return null;
  });
  if (!publication) return null;

  const data = await storeDataFor(shopId, context);
  if (!data) return null;

  let html = renderDesignerDocument({
    html: publication.html,
    css: `${publication.baseCss}\n${publication.css}`,
    data,
  });
  // Attach the context product's variant to add-to-cart buttons, then inject
  // the runtime cart script. Both are server-owned post-processing steps.
  const variantId = (data.products[0] as { variantId?: string | null } | undefined)?.variantId;
  if (variantId) {
    html = html.replace(/class="designer-add-to-cart"/g, `class="designer-add-to-cart" data-variant-id="${variantId}"`);
  }
  const nonce = randomBytes(18).toString("base64url");
  html = html.replace("</body>", `<script nonce="${nonce}">${CART_SCRIPT}</script></body>`);

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": liveCsp(nonce),
      "x-content-type-options": "nosniff",
    },
  });
}
