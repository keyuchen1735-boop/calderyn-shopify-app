import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { type EntryContext } from "react-router";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";

export const streamTimeout = 5000;

// Defense-in-depth response headers shopify-app-remix does not set. Must run
// AFTER addDocumentResponseHeaders. These do NOT touch the embedded-app iframe:
// the CSP is only AUGMENTED (object-src/base-uri appended) — frame-ancestors,
// set by Shopify, is preserved verbatim and never replaced. We never invent a
// document-wide script-src/default-src here: that would break App Bridge.
export function applySecurityHeaders(headers: Headers): void {
  headers.delete("Server");
  headers.delete("X-Powered-By");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  );
  headers.set("X-Permitted-Cross-Domain-Policies", "none");
  headers.set("X-DNS-Prefetch-Control", "off");
  headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");

  // Only augment an existing (Shopify-set) CSP; do not create one from scratch.
  const csp = headers.get("Content-Security-Policy");
  if (csp) {
    const extras: string[] = [];
    if (!/(^|;)\s*object-src\b/.test(csp)) extras.push("object-src 'none'");
    if (!/(^|;)\s*base-uri\b/.test(csp)) extras.push("base-uri 'self'");
    if (!/(^|;)\s*form-action\b/.test(csp)) extras.push("form-action 'self'");
    if (!/(^|;)\s*upgrade-insecure-requests\b/.test(csp)) {
      extras.push("upgrade-insecure-requests");
    }
    if (extras.length) {
      const sep = csp.trimEnd().endsWith(";") ? " " : "; ";
      headers.set("Content-Security-Policy", `${csp.trimEnd()}${sep}${extras.join("; ")};`);
    }
  }
}

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  reactRouterContext: EntryContext,
) {
  addDocumentResponseHeaders(request, responseHeaders);
  applySecurityHeaders(responseHeaders);
  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? "")
    ? "onAllReady"
    : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={reactRouterContext} url={request.url} />,
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
