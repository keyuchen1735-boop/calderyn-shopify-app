// RFC 8414 Authorization Server Metadata.
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
