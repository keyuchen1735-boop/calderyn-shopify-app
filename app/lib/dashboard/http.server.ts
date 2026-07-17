// app/lib/dashboard/http.server.ts
//
// Shared HTTP plumbing for /dashboard/api/*: JSON envelopes, a CSRF origin
// check for state-changing requests, and (re-exported from rate-limit.server)
// a shared Postgres-backed fixed-window rate limiter.

import { CalderynError } from "../calderyn.server";

// The limiter moved to a shared Postgres-backed store so it enforces across
// serverless instances (the old in-memory version only damped abuse per
// instance). Re-exported so existing dashboard imports keep their path.
export { rateLimit, releaseRateLimit, clientIpKey } from "~/lib/rate-limit.server";

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
  // forwards auth posts here with its own Origin header. NOTE: every origin here
  // is also a host merchant-flow redirects may return to (requireSameOrigin's
  // return value seeds e.g. the Stripe test-transaction return URLs) — only list
  // origins that actually serve the dashboard.
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
 * Absolute public origin the first-party dashboard is served from — the base for
 * every absolute URL we hand out (OAuth redirect_uri, verification / reset email
 * links, cross-host redirects). Prefer DASHBOARD_PUBLIC_URL (the apex host where
 * the __Host- session and CSRF cookies live); fall back to SHOPIFY_APP_URL.
 *
 * Uses `||`, not `??`: a present-but-empty env var (a real Vercel failure mode)
 * must fall through to the next option instead of yielding "" and a broken
 * *relative* URL. Returns "" only when neither is set.
 */
export function publicBaseUrl(): string {
  return (process.env.DASHBOARD_PUBLIC_URL || process.env.SHOPIFY_APP_URL || "").trim();
}

/**
 * CSRF origin check for POST/PUT/DELETE. Returns the 403 response when the
 * Origin (or Referer origin) is not ours, null when the request is fine.
 * Page routes must RETURN this (a thrown Response walks up to the root
 * ErrorBoundary and surfaces as a 500 error page instead of the 403 JSON).
 */
export function checkSameOrigin(request: Request): Response | null {
  return validatedOrigin(request) ? null : jsonError(403, "bad_origin");
}

/**
 * The browser origin this request came from (Origin header when PRESENT — even
 * empty, which then fails the allowlist rather than falling through — else the
 * Referer's origin), or null when neither is present/parseable.
 */
function requestOrigin(request: Request): string | null {
  const origin = request.headers.get("Origin");
  if (origin !== null) return origin;
  const ref = request.headers.get("Referer");
  try {
    return ref ? new URL(ref).origin : null;
  } catch {
    return null;
  }
}

/** The request's origin iff it is on the allowlist, else null. */
function validatedOrigin(request: Request): string | null {
  const origin = requestOrigin(request);
  return origin && allowedOrigins().includes(origin) ? origin : null;
}

/**
 * Throwing form of checkSameOrigin for resource routes (no page to render).
 * Returns the validated origin — an allowlisted dashboard host, the right base for
 * redirect URLs that must land where the caller's session cookie lives.
 */
export function requireSameOrigin(request: Request): string {
  const origin = validatedOrigin(request);
  if (!origin) throw jsonError(403, "bad_origin");
  return origin;
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

/**
 * Parse a request body as JSON, normalizing anything that isn't a plain object (a bare `null`,
 * array, string, or number is all valid JSON) down to `{}` rather than letting a later
 * `body.someField` access throw on it. Returns null on unparseable JSON so the caller can 400 —
 * distinct from "valid JSON but not an object", which is treated as an empty body (every field
 * absent) rather than a parse failure.
 */
export async function parseJsonObjectBody(request: Request): Promise<Record<string, unknown> | null> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return null;
  }
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
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
