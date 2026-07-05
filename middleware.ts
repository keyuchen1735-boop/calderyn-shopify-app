// Vercel Routing Middleware (framework-agnostic; runs ahead of the Remix
// function). The dashboard is served behind the marketing-apex proxy
// (calderyncompany.com/dashboard/* -> app.calderyncompany.com), so a browser
// form POST arrives with `Origin: <apex>` but `x-forwarded-host: <app>`. Remix's
// built-in throwIfPotentialCSRFAttack compares those hosts and 500s on the
// mismatch before our own allowlist-aware checkSameOrigin can run.
//
// For a mutating request whose Origin we already trust (same allowlist the
// server action check uses), reconcile x-forwarded-host to the Origin host so
// Remix's naive check passes; our checkSameOrigin remains the authoritative CSRF
// gate. Untrusted origins are left untouched for Remix to reject.
import { next } from "@vercel/functions/middleware";
import { parseAllowedOrigins, forwardedHostFix } from "./app/lib/proxy-csrf";

export const config = { matcher: "/dashboard/:path*" };

export default function middleware(request: Request): Response {
  const allowed = parseAllowedOrigins([
    process.env.DASHBOARD_PUBLIC_URL,
    process.env.SHOPIFY_APP_URL,
    process.env.DASHBOARD_ALLOWED_ORIGINS,
  ]);

  const fixHost = forwardedHostFix(request.method, request.headers, allowed);
  if (!fixHost) return next();

  const headers = new Headers(request.headers);
  headers.set("x-forwarded-host", fixHost);
  return next({ request: { headers } });
}
