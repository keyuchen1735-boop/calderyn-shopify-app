// Renders a designer document for the sandboxed preview iframe. Two layers of
// safety, both owned by this engine: a scrub pass strips script-capable markup
// and external network references, and the preview response itself ships a
// no-script CSP with an iframe sandbox so anything the scrub missed is inert
// in the browser.
import type { DesignerStoreData } from "./types";

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

export function scrubDesignerCss(css: string): string {
  return scrubExternalUrls(css).replace(BLOCKED_TAGS, "").replace(/expression\s*\(/gi, "invalid(");
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
  switch (path) {
    case "store.name": return escapeHtml(data.storeName);
    case "store.tagline": return escapeHtml(data.tagline ?? "");
    case "store.logo": return escapeHtml(data.logoUrl ?? NEUTRAL_IMAGE);
    case "cart.count": return "0";
    case "collection.title": return "Everything";
    case "collection.description": return escapeHtml(data.tagline ?? "");
    case "collection.count": return String(data.products.length);
    case "search.query": return "";
    default: return "";
  }
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
}): { bodyHtml: string; css: string } {
  const scrubbedHtml = scrubDesignerHtml(input.html);
  const products = input.data.products.slice(0, input.maxProducts ?? 12);
  const contextProduct = products[0];
  const withLoops = scrubbedHtml.replace(/\{\{#products\}\}([\s\S]*?)\{\{\/products\}\}/g, (match, body: string) =>
    products.map((product) =>
      body.replace(/\{\{(product\.[a-zA-Z]+)\}\}/g, (m, path: string) => productValue(product, path)),
    ).join("\n"));
  const filled = withLoops.replace(/\{\{([a-zA-Z.]+)\}\}/g, (match, path: string) =>
    path.startsWith("product.")
      ? (contextProduct ? productValue(contextProduct, path) : "")
      : rootValue(input.data, path));
  return { bodyHtml: filled, css: scrubDesignerCss(input.css).replace(/<\/style/gi, "") };
}

/** Full standalone document for the sandboxed preview iframe. */
export function renderDesignerDocument(input: {
  html: string;
  css: string;
  data: DesignerStoreData;
  maxProducts?: number;
}): string {
  const { bodyHtml, css } = renderDesignerBody(input);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body>${bodyHtml}</body></html>`;
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
