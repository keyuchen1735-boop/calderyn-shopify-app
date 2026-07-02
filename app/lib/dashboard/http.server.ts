// app/lib/dashboard/http.server.ts
//
// Shared HTTP plumbing for /dashboard/api/*: JSON envelopes, a CSRF origin
// check for state-changing requests, and (re-exported from rate-limit.server)
// a shared Postgres-backed fixed-window rate limiter.

import { CalderynError } from "../calderyn.server";

// The limiter moved to a shared Postgres-backed store so it enforces across
// serverless instances (the old in-memory version only damped abuse per
// instance). Re-exported so existing dashboard imports keep their path.
export { rateLimit, clientIpKey } from "~/lib/rate-limit.server";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  // Dashboard API JSON is never legitimately embedded cross-origin; block
  // no-cors subresource reads (Spectre-class side channels).
  "Cross-Origin-Resource-Policy": "same-site",
};

export function jsonOk(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { ...JSON_HEADERS, ...(init.headers as Record<string, string>) },
  });
}

export function jsonError(status: number, error: string, message?: string): Response {
  return new Response(JSON.stringify(message ? { error, message } : { error }), {
    status,
    headers: JSON_HEADERS,
  });
}

function allowedOrigins(): string[] {
  return [process.env.DASHBOARD_PUBLIC_URL, process.env.SHOPIFY_APP_URL]
    .filter((v): v is string => Boolean(v))
    .map((v) => new URL(v).origin);
}

/** CSRF guard for POST/PUT/DELETE: Origin (or Referer origin) must be ours. */
export function requireSameOrigin(request: Request): void {
  const origin =
    request.headers.get("Origin") ??
    (() => {
      const ref = request.headers.get("Referer");
      try {
        return ref ? new URL(ref).origin : null;
      } catch {
        return null;
      }
    })();
  if (!origin || !allowedOrigins().includes(origin)) {
    throw jsonError(403, "bad_origin");
  }
}

/** Wrap a loader/action body: CalderynError → its status/code; rethrow Responses. */
export async function dashboardJson(fn: () => Promise<unknown>): Promise<Response> {
  try {
    return jsonOk(await fn());
  } catch (err) {
    if (err instanceof Response) throw err;
    if (err instanceof CalderynError) {
      return jsonError(err.status, err.code, err.message);
    }
    console.error("[dashboard.api] unhandled error", err);
    return jsonError(500, "internal_error");
  }
}
