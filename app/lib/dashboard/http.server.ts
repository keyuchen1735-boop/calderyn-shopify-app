// app/lib/dashboard/http.server.ts
//
// Shared HTTP plumbing for /dashboard/api/*: JSON envelopes, a CSRF origin
// check for state-changing requests, and a fixed-window in-memory rate
// limiter (per serverless instance — coarse abuse damping, not a guarantee).

import { CalderynError } from "../calderyn.server";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
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

type Window = { count: number; resetAt: number };
const windows = new Map<string, Window>();

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const w = windows.get(key);
  if (!w || w.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  w.count += 1;
  return w.count <= limit;
}

export function __resetRateLimiterForTests(): void {
  windows.clear();
}

/** Stable per-client key for rate limiting (Vercel sets x-forwarded-for). */
export function clientIpKey(request: Request, scope: string): string {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  return `${scope}:${ip}`;
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
