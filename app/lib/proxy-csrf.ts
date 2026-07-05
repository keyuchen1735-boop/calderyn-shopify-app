// Pure, edge-safe helpers shared by the root Vercel routing middleware
// (middleware.ts) and its unit test. No Node-only imports so the middleware
// bundle stays valid on the Edge runtime — only Web-standard URL / Headers / Set.
//
// Why this exists: the dashboard is served behind the marketing-apex proxy
// (calderyncompany.com/dashboard/* -> app.calderyncompany.com). On a document
// form POST the browser sends `Origin: <apex>` while Vercel injects
// `x-forwarded-host: <app>`. Remix's built-in throwIfPotentialCSRFAttack
// compares those two hosts and 500s on the mismatch *before* our own
// allowlist-aware checkSameOrigin runs. For requests whose Origin we already
// trust, the middleware reconciles the two so Remix's naive check passes and
// our real CSRF gate stays authoritative.

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Normalize the env-configured origin allowlist into a Set of origins. Mirrors
 * allowedOrigins() in app/lib/dashboard/http.server.ts (kept in sync on purpose)
 * so the edge check trusts exactly the same origins as the server action check.
 */
export function parseAllowedOrigins(values: (string | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const raw of values) {
    for (const part of (raw ?? "").split(",")) {
      const value = part.trim();
      if (!value) continue;
      try {
        out.add(new URL(value).origin);
      } catch {
        // A malformed entry must not take the whole allowlist down.
      }
    }
  }
  return out;
}

/**
 * Decide whether Remix's built-in x-forwarded-host/Origin CSRF check would
 * false-positive on a *trusted* proxied request. Returns the host to force
 * `x-forwarded-host` to (the Origin's host, so origin === xfh and Remix's check
 * passes), or null when nothing should change:
 *   - non-mutating method (Remix only checks POST/PUT/PATCH/DELETE),
 *   - no/`null` Origin (Remix skips the check; our own falls back to Referer),
 *   - Origin host already equals x-forwarded-host (nothing to reconcile),
 *   - Origin is NOT in the allowlist — left as-is so Remix rejects it (correct).
 */
export function forwardedHostFix(
  method: string,
  headers: Headers,
  allowed: Set<string>,
): string | null {
  if (!MUTATING.has(method.toUpperCase())) return null;

  const originHeader = headers.get("origin");
  if (!originHeader || originHeader === "null") return null;

  let origin: URL;
  try {
    origin = new URL(originHeader);
  } catch {
    return null;
  }

  const xfh = (headers.get("x-forwarded-host") ?? "").split(",")[0]?.trim();
  if (!xfh || origin.host === xfh) return null; // already consistent
  if (!allowed.has(origin.origin)) return null; // untrusted -> let Remix reject

  return origin.host;
}
