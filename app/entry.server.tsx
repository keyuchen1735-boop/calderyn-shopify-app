import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { RemixServer } from "@remix-run/react";
import {
  createReadableStreamFromReadable,
  type EntryContext,
} from "@remix-run/node";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";

export const streamTimeout = 5000;

// Paths that Shopify frames inside the admin (embedded app + OAuth). These must
// never receive X-Frame-Options or a frame-ancestors 'none' CSP or the iframe
// stops loading; Shopify supplies their frame-ancestors itself.
const EMBEDDED_PATH = /^\/(?:app|auth)(?:\/|$)/;

// Directives appended to every document response regardless of surface. None of
// these constrain script execution, so they cannot break inline hydration or
// App Bridge.
const HARDENING_DIRECTIVES = [
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
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
export function applySecurityHeaders(headers: Headers, pathname?: string): void {
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
    "camera=(), microphone=(), geolocation=(), browsing-topics=(), usb=(), interest-cohort=()",
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
  addDocumentResponseHeaders(request, responseHeaders);
  applySecurityHeaders(responseHeaders, new URL(request.url).pathname);
  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? "")
    ? "onAllReady"
    : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <RemixServer
        context={remixContext}
        url={request.url}
        abortDelay={streamTimeout + 1000}
      />,
      {
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
