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
  // DASHBOARD_ALLOWED_ORIGINS: comma-separated extra origins that may submit
  // state-changing requests — e.g. the marketing apex, whose /dashboard/* proxy
  // forwards auth posts here with its own Origin header.
  const candidates = [
    process.env.DASHBOARD_PUBLIC_URL,
    process.env.SHOPIFY_APP_URL,
    ...(process.env.DASHBOARD_ALLOWED_ORIGINS ?? "").split(","),
  ];
  const origins = new Set<string>();
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (!value) continue;
    try {
      origins.add(new URL(value).origin);
    } catch {
      // A malformed entry must not take the whole allowlist (and every
      // mutation) down with it.
    }
  }
  return [...origins];
}

/**
 * CSRF origin check for POST/PUT/DELETE. Returns the 403 response when the
 * Origin (or Referer origin) is not ours, null when the request is fine.
 * Page routes must RETURN this (a thrown Response walks up to the root
 * ErrorBoundary and surfaces as a 500 error page instead of the 403 JSON).
 */
export function checkSameOrigin(request: Request): Response | null {
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
    return jsonError(403, "bad_origin");
  }
  return null;
}

/** Throwing form of checkSameOrigin for resource routes (no page to render). */
export function requireSameOrigin(request: Request): void {
  const bad = checkSameOrigin(request);
  if (bad) throw bad;
}

/**
 * True when the client asked for JSON (fetch-based forms send
 * `Accept: application/json`). Auth actions use this to keep the JSON error
 * contract for programmatic clients while plain HTML form posts get a
 * redirect back to the page with the error code in the query string —
 * never a raw JSON body in the browser tab.
 */
export function wantsJson(request: Request): boolean {
  return (request.headers.get("Accept") ?? "").includes("application/json");
}

// Only same-origin dashboard paths may be carried through an auth round-trip
// (Shopify OAuth, Google, or the native signin form), so a crafted ?return_to=
// cannot turn sign-in into an open redirect. Rejects absolute URLs,
// protocol-relative (//host), backslash tricks, and control chars: a CR/LF
// survives the round-trip into a Location header (CRLF injection / response
// splitting / a 500 when the runtime rejects it).
export function safeDashboardReturnTo(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/dashboard/")) return null;
  if (raw.startsWith("//") || raw.includes("\\") || raw.includes("://")) return null;
  // eslint-disable-next-line no-control-regex -- intentionally matching control chars
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  return raw;
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
