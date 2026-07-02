/**
 * JSON Response helper for resource routes.
 *
 * React Router 7 removed the framework-level `json()` util: UI loaders and
 * actions now return plain objects or `data()`, which flow through the
 * single-fetch encoder. Resource routes (cron endpoints, ACP/MCP APIs,
 * webhooks, dashboard APIs) still speak raw HTTP to external callers, so they
 * keep constructing real `Response` objects. This helper preserves the exact
 * wire behavior of the old `json()`: JSON body plus an application/json
 * content type, with an optional status or full ResponseInit.
 */
export function json<Data>(payload: Data, init?: number | ResponseInit): Response {
  const responseInit: ResponseInit =
    typeof init === "number" ? { status: init } : (init ?? {});
  const headers = new Headers(responseInit.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }
  return new Response(JSON.stringify(payload), { ...responseInit, headers });
}
