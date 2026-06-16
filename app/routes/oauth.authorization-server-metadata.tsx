// RFC 8414 Authorization Server Metadata.
//
// Served at the canonical /.well-known/oauth-authorization-server URL via a
// rewrite in vercel.json. The route file itself lives at a NON-dot path on
// purpose: when this route served the /.well-known/... URL directly, its
// Vercel function landed under `.vercel/output/functions/.well-known/...func`
// — the only dot-prefixed function dir — and @vercel/remix makes the first
// route its single "real" server function that every other route symlinks to.
// Vercel's cloud build dropped that dot-dir function, so all Node routes lost
// their symlink target and the POST-only Python api function answered every
// request with 501 (full dashboard/extension outage). Keeping the function at
// a non-dot path keeps the shared Node function off the fragile dot dir.
//
// Gated on MCP_OAUTH_ENABLED — when disabled, 404 so the rollout flag is total.
import { json } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";

export const loader = async ({ request: _ }: LoaderFunctionArgs) => {
  if (process.env.MCP_OAUTH_ENABLED !== "true") {
    return new Response("Not Found", { status: 404 });
  }
  const issuer = process.env.SHOPIFY_APP_URL || "https://app.calderyncompany.com";
  return json(
    {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["read"],
    },
    // RFC 8414 metadata is public and fetched cross-origin by OAuth clients
    // (e.g. Claude.ai's connector discovery) — without CORS the browser
    // fetch fails even though curl works.
    { headers: { "Access-Control-Allow-Origin": "*" } },
  );
};
