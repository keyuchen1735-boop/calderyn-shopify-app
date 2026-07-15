import { PassThrough } from "stream";
import { randomBytes } from "crypto";
import { renderToPipeableStream } from "react-dom/server";
import { RemixServer } from "@remix-run/react";
import {
  createReadableStreamFromReadable,
  type EntryContext,
} from "@remix-run/node";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";
import {
  buildStorefrontCsp,
  resolveStorefrontBundleNonce,
  resolveStorefrontCspSurface,
  stripStorefrontRendererHeader,
} from "./lib/storefront-runtime/csp.server";

export const streamTimeout = 5000;

export function rootLoaderNonce(loaderData: unknown): string | undefined {
  if (loaderData === null || typeof loaderData !== "object") return undefined;
  const root = (loaderData as { root?: unknown }).root;
  if (root === null || typeof root !== "object") return undefined;
  const nonce = (root as { nonce?: unknown }).nonce;
  return typeof nonce === "string" ? nonce : undefined;
}

// Paths that Shopify frames inside the admin (embedded app + OAuth). These must
// never receive X-Frame-Options or a frame-ancestors 'none' CSP or the iframe
// stops loading; Shopify supplies their frame-ancestors itself.
const EMBEDDED_PATH = /^\/(?:app|auth)(?:\/|$)/;

// The Store studio embeds its own draft storefront preview in a same-origin
// iframe. That page must allow framing by its own origin (not X-Frame-Options:
// DENY, which blocks even same-origin), while still refusing cross-origin frames
// so it can't be clickjacked. Anchored to the exact path so a future child route
// under this prefix can't silently inherit the framing relaxation.
const SELF_FRAMEABLE_PATH = /^\/dashboard\/store\/preview$/;

// Directives appended to every document response regardless of surface. None of
// these constrain script execution, so they cannot break inline hydration or
// App Bridge.
const HARDENING_DIRECTIVES = [
  "object-src 'none'",
  "base-uri 'self'",
  // The Shopify hosts are required: Chrome enforces form-action across a form
  // submission's redirect chain, and the connector login form (/oauth/login)
  // 302s into admin.shopify.com (which may hop through accounts.shopify.com
  // and <shop>.myshopify.com for merchant login). 'self' alone silently kills
  // that navigation — the submit button does nothing.
  "form-action 'self' https://*.myshopify.com https://accounts.shopify.com https://admin.shopify.com",
  "upgrade-insecure-requests",
];

// Defense-in-depth response headers shopify-app-remix does not set. Must run
// AFTER addDocumentResponseHeaders. Two surfaces:
//  - Embedded admin (Shopify set a CSP with frame-ancestors): only AUGMENT it —
//    frame-ancestors is preserved verbatim and X-Frame-Options is never set, so
//    the admin iframe is untouched. We never invent a document-wide
//    script-src/default-src here: that would break App Bridge.
//  - Non-embedded surfaces (dashboard, storefront, oauth, marketing): Shopify
//    sets no CSP, so framing is locked down with X-Frame-Options: DENY and a
//    frame-ancestors 'none' CSP to defeat clickjacking on those pages.
export function applySecurityHeaders(headers: Headers, pathname?: string, storefrontNonce?: string): void {
  // Server is deleted for completeness, but Vercel re-adds it at the edge, so
  // do not rely on its absence. X-Powered-By stays suppressed.
  headers.delete("Server");
  headers.delete("X-Powered-By");
  headers.set("X-Content-Type-Options", "nosniff");
  // Do not clobber a stricter per-route Referrer-Policy (e.g. no-referrer on the
  // password-reset / email-verify token pages).
  if (!headers.has("Referrer-Policy")) {
    headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  }
  headers.set(
    "Permissions-Policy",
    // geolocation=(self): the Weather tab's "Use my location" runs the browser
    // geolocation prompt on our own origin; everything else stays denied.
    "camera=(), microphone=(), geolocation=(self), browsing-topics=(), usb=(), interest-cohort=()",
  );
  headers.set("X-Permitted-Cross-Domain-Policies", "none");
  headers.set("X-DNS-Prefetch-Control", "off");
  headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  // Cross-origin isolation parity with the apex origin. COOP is ignored for the
  // Shopify-framed embedded admin; same-origin-allow-popups keeps any popup flow
  // (e.g. Stripe wallet sheets) working while severing reverse-tabnabbing handles.
  headers.set("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  headers.set("Origin-Agent-Cluster", "?1");

  // Authenticated document shells (admin, dashboard, checkout) must not persist
  // in shared or back/forward caches. Route-set values win.
  if (
    pathname !== undefined &&
    (/^\/(?:app|dashboard)(?:\/|$)/.test(pathname) ||
      pathname.startsWith("/storefront/checkout")) &&
    !headers.has("Cache-Control")
  ) {
    headers.set("Cache-Control", "no-store");
  }

  const storefrontSurface = pathname === undefined ? null : resolveStorefrontCspSurface(headers, pathname);
  stripStorefrontRendererHeader(headers);
  if (storefrontSurface && storefrontNonce) {
    headers.set(
      "Content-Security-Policy",
      buildStorefrontCsp({
        nonce: storefrontNonce,
        surface: storefrontSurface,
        supabaseUrl: process.env.SUPABASE_URL,
        ownedMediaOrigin: process.env.STOREFRONT_OWNED_MEDIA_ORIGIN,
      }),
    );
  }

  const csp = headers.get("Content-Security-Policy");
  if (csp) {
    // Embedded admin: append missing hardening directives, preserving Shopify's
    // frame-ancestors. Never set X-Frame-Options here.
    const extras = HARDENING_DIRECTIVES.filter((directive) => {
      const name = directive.split(" ")[0];
      return !new RegExp(`(^|;)\\s*${name}\\b`).test(csp);
    });
    if (extras.length) {
      const sep = csp.trimEnd().endsWith(";") ? " " : "; ";
      headers.set("Content-Security-Policy", `${csp.trimEnd()}${sep}${extras.join("; ")};`);
    }
    return;
  }

  // No Shopify CSP. An embedded path may legitimately have none (e.g. an error
  // response) — leave its framing alone so the admin iframe is unaffected.
  if (pathname !== undefined && EMBEDDED_PATH.test(pathname)) {
    return;
  }

  // The studio's own draft preview: allow same-origin framing only. SAMEORIGIN
  // for legacy browsers, frame-ancestors 'self' for the rest — cross-origin
  // clickjacking is still refused. The page displays sanitized store HTML and
  // hydrates first-party effect runtimes (shader/motion), so it runs its own
  // bundles plus Remix's inline hydration context: script-src 'self'
  // 'unsafe-inline'. Model-authored script never reaches here — the HTML
  // sanitizer strips it at persistence — and remote script stays blocked, so no
  // third-party code can execute.
  if (pathname !== undefined && SELF_FRAMEABLE_PATH.test(pathname)) {
    headers.set("X-Frame-Options", "SAMEORIGIN");
    headers.set(
      "Content-Security-Policy",
      `frame-ancestors 'self'; script-src 'self' 'unsafe-inline'; ${HARDENING_DIRECTIVES.join("; ")};`,
    );
    return;
  }

  // Non-embedded surface: deny framing (X-Frame-Options for legacy browsers,
  // frame-ancestors 'none' for the rest).
  headers.set("X-Frame-Options", "DENY");
  headers.set(
    "Content-Security-Policy",
    `frame-ancestors 'none'; ${HARDENING_DIRECTIVES.join("; ")};`,
  );
}

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  remixContext: EntryContext,
) {
  const pathname = new URL(request.url).pathname;
  const storefrontNonce = resolveStorefrontCspSurface(responseHeaders, pathname)
    ? resolveStorefrontBundleNonce(responseHeaders) ??
      rootLoaderNonce(remixContext.staticHandlerContext.loaderData) ??
      randomBytes(18).toString("base64url")
    : undefined;
  addDocumentResponseHeaders(request, responseHeaders);
  applySecurityHeaders(responseHeaders, pathname, storefrontNonce);
  const userAgent = request.headers.get("user-agent");
  // The local Orders preview has no deferred content to stream. Waiting for the
  // complete document prevents the dev module from hydrating while Remix's
  // single-fetch transport is still appending its tail nodes.
  const callbackName = isbot(userAgent ?? "") || pathname === "/orders-preview"
    ? "onAllReady"
    : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <RemixServer
        context={remixContext}
        url={request.url}
        abortDelay={streamTimeout + 1000}
        nonce={storefrontNonce}
      />,
      {
        nonce: storefrontNonce,
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );
          pipe(body);
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          // eslint-disable-next-line no-param-reassign
          responseStatusCode = 500;
          console.error(error);
        },
      },
    );

    setTimeout(abort, streamTimeout + 1000);
  });
}
