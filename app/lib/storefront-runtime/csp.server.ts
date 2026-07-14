const NONCE_PATTERN = /^[A-Za-z0-9+/_=-]{8,160}$/;
const BUNDLE_RENDERER_HEADER = "X-Calderyn-Storefront-Renderer";
const BUNDLE_RENDERER_VALUE = "bundle-v1";
const BUNDLE_NONCE_HEADER = "X-Calderyn-Storefront-Nonce";
const SHOPIFY_CDN_ORIGIN = "https://cdn.shopify.com";

export type StorefrontCspSurface = "browse" | "checkout" | "accountCards";

export function isStorefrontDocumentPath(pathname: string): boolean {
  return /^\/storefront(?:\/|$)/.test(pathname) && !/^\/storefront\/api(?:\/|$)/.test(pathname);
}

export function isStorefrontBundleReadEnabled(value = process.env.STOREFRONT_BUNDLE_READ): boolean {
  return /^(?:1|true)$/i.test(value ?? "");
}

export function markStorefrontBundleRendered(headers: Headers, nonce?: string): void {
  headers.set(BUNDLE_RENDERER_HEADER, BUNDLE_RENDERER_VALUE);
  if (nonce) {
    if (!NONCE_PATTERN.test(nonce)) throw new Error("Invalid storefront CSP nonce");
    headers.set(BUNDLE_NONCE_HEADER, nonce);
  }
}

export function resolveStorefrontBundleNonce(headers: Headers): string | undefined {
  const nonce = headers.get(BUNDLE_NONCE_HEADER);
  return nonce && NONCE_PATTERN.test(nonce) ? nonce : undefined;
}

export function resolveStorefrontCspSurface(headers: Headers, pathname: string): StorefrontCspSurface | null {
  if (!isStorefrontDocumentPath(pathname)) return null;
  if (pathname.startsWith("/storefront/checkout")) return "checkout";
  if (/^\/storefront\/account\/cards\/?$/.test(pathname)) return "accountCards";
  return headers.get(BUNDLE_RENDERER_HEADER) === BUNDLE_RENDERER_VALUE ? "browse" : null;
}

export function stripStorefrontRendererHeader(headers: Headers): void {
  headers.delete(BUNDLE_RENDERER_HEADER);
  headers.delete(BUNDLE_NONCE_HEADER);
}

function directive(name: string, values: readonly string[]): string {
  return `${name} ${values.join(" ")}`;
}

function configuredHttpsOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

function unique(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))];
}

export function buildStorefrontCsp(input: {
  nonce: string;
  surface: StorefrontCspSurface;
  supabaseUrl?: string;
  ownedMediaOrigin?: string;
}): string {
  if (!NONCE_PATTERN.test(input.nonce)) throw new Error("Invalid storefront CSP nonce");
  const nonce = `'nonce-${input.nonce}'`;
  const stripe = input.surface === "checkout" || input.surface === "accountCards";
  const mediaOrigins = unique([
    SHOPIFY_CDN_ORIGIN,
    configuredHttpsOrigin(input.supabaseUrl),
    configuredHttpsOrigin(input.ownedMediaOrigin),
  ]);
  const stripeScript = stripe ? ["https://js.stripe.com"] : [];
  const stripeConnect = stripe
    ? ["https://api.stripe.com", "https://r.stripe.com", "https://m.stripe.network"]
    : [];
  const stripeFrames = stripe ? ["https://js.stripe.com", "https://hooks.stripe.com"] : [];
  const stripeImages = stripe ? ["https://*.stripe.com", "https://*.stripe.network"] : [];
  return [
    directive("default-src", ["'none'"]),
    directive("script-src", ["'self'", nonce, ...stripeScript]),
    directive("style-src", ["'self'", nonce, SHOPIFY_CDN_ORIGIN]),
    directive("connect-src", ["'self'", ...stripeConnect]),
    directive("font-src", ["'self'", SHOPIFY_CDN_ORIGIN]),
    directive("img-src", ["'self'", "data:", "blob:", ...mediaOrigins, ...stripeImages]),
    directive("frame-src", stripe ? stripeFrames : ["'none'"]),
    directive("object-src", ["'none'"]),
    directive("worker-src", ["'none'"]),
    directive("form-action", ["'self'"]),
    directive("base-uri", ["'self'"]),
    directive("frame-ancestors", ["'none'"]),
    "upgrade-insecure-requests",
  ].join("; ") + ";";
}
