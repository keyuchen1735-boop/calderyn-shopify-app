// Renders a designer document for the sandboxed preview iframe. Two layers of
// safety, both owned by this engine: a scrub pass strips script-capable markup
// and external network references, and the preview response itself ships a
// no-script CSP with an iframe sandbox so anything the scrub missed is inert
// in the browser.
import type { DesignerStoreData } from "./types";
import { DESIGNER_FONT_IDS } from "./direction.server";
import { expandCouponWidget } from "./widgets";

const BLOCKED_TAGS = /<\/?(?:script|iframe|object|embed|base|form|link|meta)\b[^>]*>/gi;
// Event handlers in every quote style, including unquoted (onclick=steal()).
const EVENT_ATTRS = /\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
// javascript:/data:text in navigable/loading attrs, every quote style.
const JS_URLS = /\s(?:href|src|srcset|action|formaction)\s*=\s*(?:"(?:\s*(?:javascript|data:text))[^"]*"|'(?:\s*(?:javascript|data:text))[^']*'|(?:javascript|data:text)[^\s>]*)/gi;

/** Only same-origin and data-image URLs survive; the CSP enforces the same.
 *  The preview CSP allows img-src https: (catalog imagery is injected after
 *  the scrub), so a resource-loading attribute the model authored with an
 *  external URL would auto-beacon the viewer — strip those in every quote
 *  style, not just double-quoted. */
function scrubExternalUrls(value: string): string {
  return value
    // src / srcset / poster pointing off-origin: double, single, or unquoted.
    .replace(/\s(?:src|srcset|poster)\s*=\s*"(?:https?:)?\/\/[^"]*"/gi, "")
    .replace(/\s(?:src|srcset|poster)\s*=\s*'(?:https?:)?\/\/[^']*'/gi, "")
    .replace(/\s(?:src|srcset|poster)\s*=\s*(?:https?:)?\/\/[^\s>]*/gi, "")
    // SVG <image>/<use> load through xlink:href, which never appears on anchors.
    .replace(/\sxlink:href\s*=\s*(?:"(?:https?:)?\/\/[^"]*"|'(?:https?:)?\/\/[^']*'|(?:https?:)?\/\/[^\s>]*)/gi, "")
    .replace(/url\(\s*(['"]?)(?:https?:)?\/\/[^)]*\)/gi, "none")
    .replace(/@import[^;]+;/gi, "");
}

export function scrubDesignerHtml(html: string): string {
  return scrubExternalUrls(
    html.replace(BLOCKED_TAGS, "").replace(EVENT_ATTRS, "").replace(JS_URLS, ""),
  );
}

/** Model-authored CSS can reference any /storefront-fonts/<id> it invents,
 *  but only the curated ids exist on disk — an unknown id 404s on every page
 *  view (a published store shipped "jetbrains-mono" this way before it was
 *  curated). Unknown ids get a curated substitute file, so the @font-face
 *  alias the model chose still resolves to a real font. */
const CURATED_FONT_FILE_IDS = new Set<string>(DESIGNER_FONT_IDS);

function substituteFontId(id: string): string {
  if (/mono|code/.test(id)) return "ibm-plex-mono";
  if (/serif|slab|garamond|playfair|georgia/.test(id)) return "source-serif-4";
  return "inter";
}

export function enforceCuratedFontFiles(css: string): string {
  return css.replace(
    /\/storefront-fonts\/([a-z0-9-]+)-latin\.woff2/gi,
    (match, id: string) => {
      const slug = id.toLowerCase();
      return CURATED_FONT_FILE_IDS.has(slug)
        ? match
        : `/storefront-fonts/${substituteFontId(slug)}-latin.woff2`;
    },
  );
}

export function scrubDesignerCss(css: string): string {
  return enforceCuratedFontFiles(
    scrubExternalUrls(css).replace(BLOCKED_TAGS, "").replace(/expression\s*\(/gi, "invalid("),
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function money(cents: number | null | undefined): string {
  return typeof cents === "number" ? `$${(cents / 100).toFixed(2)}` : "";
}

const NEUTRAL_IMAGE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 10'%3E%3Crect width='8' height='10' fill='%23e7e5e4'/%3E%3Cpath d='M0 8l2.4-2.8 1.4 1.5 1.5-1.9L8 8.1V10H0z' fill='%23a8a29e'/%3E%3Ccircle cx='6' cy='3' r='1' fill='%23fafaf9'/%3E%3C/svg%3E";

function productValue(product: DesignerStoreData["products"][number], path: string): string {
  switch (path) {
    case "product.title": return escapeHtml(product.title);
    case "product.description": return escapeHtml(product.description ?? "");
    case "product.price": return money(product.priceCents);
    case "product.compareAtPrice": return money(product.compareAtPriceCents);
    case "product.availability": return product.available ? "In stock" : "Sold out";
    case "product.image": return escapeHtml(product.imageUrl ?? NEUTRAL_IMAGE);
    case "product.url": return `/storefront/products/${encodeURIComponent(product.handle)}`;
    default: return "";
  }
}

function rootValue(data: DesignerStoreData, path: string): string {
  // Generated imagery: {{asset.hero}} etc. Absent assets fall back to the
  // neutral image so an img src never renders empty/broken.
  if (path.startsWith("asset.")) {
    return data.assets?.[path.slice("asset.".length)] ?? NEUTRAL_IMAGE;
  }
  switch (path) {
    case "store.name": return escapeHtml(data.storeName);
    case "store.tagline": return escapeHtml(data.tagline ?? "");
    case "store.logo": return escapeHtml(data.logoUrl ?? NEUTRAL_IMAGE);
    case "cart.count": return "0";
    case "collection.title": return escapeHtml(data.collectionTitle ?? "Everything");
    case "collection.description": return escapeHtml(data.tagline ?? "");
    case "collection.count": return String(data.products.length);
    case "search.query": return escapeHtml(data.searchQuery ?? "");
    default: return "";
  }
}

/** Per-product cart binding, stamped where the loop knows which product each
 *  card belongs to. Sold-out products are marked instead so the runtime cart
 *  script refuses the click — an "In stock"-labeled dead button was worse. */
function stampCartBinding(cardHtml: string, product: DesignerStoreData["products"][number]): string {
  return cardHtml.replace(/class="([^"]*\bdesigner-add-to-cart\b[^"]*)"/g, (match, classes: string) =>
    product.available && product.variantId
      ? `class="${classes}" data-variant-id="${escapeHtml(product.variantId)}"`
      : `class="${classes}" data-designer-sold-out=""`,
  );
}

/** Interprets the document's placeholder vocabulary: {{path}} substitutions
 *  plus one construct, {{#products}}...{{/products}}, repeated per product.
 *  Loose product placeholders (the product page is a single-product view, no
 *  loop) render against a representative product — the first in the list —
 *  so the document shows real data instead of empty attributes. */
export function renderDesignerBody(input: {
  html: string;
  css: string;
  data: DesignerStoreData;
  maxProducts?: number;
  /** Preview renders widgets inertly (no behavior script); live serving wires
   *  the returned widgetScript through a nonce. */
  preview?: boolean;
}): { bodyHtml: string; css: string; widgetScript: string } {
  const scrubbedHtml = scrubDesignerHtml(input.html);
  const products = input.data.products.slice(0, input.maxProducts ?? 12);
  const contextProduct = products[0];
  const withLoops = scrubbedHtml.replace(/\{\{#products\}\}([\s\S]*?)\{\{\/products\}\}/g, (match, body: string) =>
    products.map((product) =>
      stampCartBinding(
        body.replace(/\{\{(product\.[a-zA-Z]+)\}\}/g, (m, path: string) => productValue(product, path)),
        product,
      ),
    ).join("\n"));
  const filled = withLoops
    .replace(/\{\{([a-zA-Z0-9_.-]+)\}\}/g, (match, path: string) =>
      path.startsWith("product.")
        ? (contextProduct ? productValue(contextProduct, path) : "")
        : rootValue(input.data, path))
    // The model occasionally invents loop names ({{#related.products}}) despite
    // the prompt; unknown sentinels must vanish, never render as literal text.
    .replace(/\{\{[#/][^}]*\}\}/g, "");
  // Expand any declared conversion widget (coupon popup). In the body path
  // this is the live-storefront render, so behavior is wired by the caller
  // via the returned script; preview uses renderDesignerDocument below.
  const widget = expandCouponWidget(filled, {
    preview: input.preview === true,
    redeemableCodes: input.data.redeemableCodes,
  });
  // Generated imagery may also be referenced from CSS (hero as a section
  // background). Substitute AFTER the scrub, like the HTML imagery injection,
  // so owned https URLs survive the external-url strip.
  const filledCss = scrubDesignerCss(input.css).replace(/\{\{asset\.([a-z0-9_-]+)\}\}/g, (m, key: string) =>
    input.data.assets?.[key] ?? NEUTRAL_IMAGE);
  const css = `${filledCss}\n${widget.css}`.replace(/<\/style/gi, "");
  return { bodyHtml: widget.html, css, widgetScript: widget.script };
}

/** Full standalone document for the sandboxed preview iframe. In the preview
 *  every link is inert (the iframe has no scripts and its own route can't serve
 *  storefront paths, so a click would navigate to a dead URL). Neutralize
 *  navigation by dropping href/action and disabling submit-type buttons — the
 *  design still renders exactly, it just doesn't try to go anywhere. */
export function renderDesignerDocument(input: {
  html: string;
  css: string;
  data: DesignerStoreData;
  maxProducts?: number;
}): string {
  const { bodyHtml, css } = renderDesignerBody({ ...input, preview: true });
  const inert = bodyHtml
    .replace(/\s(href|action|formaction)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/<a(\s|>)/gi, '<a style="cursor:default"$1');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base target="_self"><style>${css}</style></head><body>${inert}</body></html>`;
}

// img-src allows https: because catalog imagery is injected server-side after
// the scrub (signed Supabase URLs, promoted Shopify CDN hotlinks); documents
// themselves can never carry an external src — the scrub strips those.
export const DESIGNER_PREVIEW_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "script-src 'none'",
].join("; ");
