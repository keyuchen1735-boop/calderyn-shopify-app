// app/routes/oauth.token.tsx
// Public POST endpoint — OAuth 2.1 token endpoint.
// Supports: authorization_code and refresh_token grant types.
// Body must be application/x-www-form-urlencoded per RFC 6749 §4.
import type { ActionFunctionArgs } from "react-router";
import { json } from "~/lib/response.server";
import { consumeAuthCode, getClient } from "~/lib/mcp_oauth.server";
import { mintAccessToken, rotateRefreshToken } from "~/lib/mcp_tokens.server";
import { rateLimit, clientIpKey } from "~/lib/dashboard/http.server";

const FLAG_ON = () => process.env.MCP_OAUTH_ENABLED === "true";

const TOKEN_HEADERS = { "cache-control": "no-store", pragma: "no-cache" };

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!FLAG_ON()) return new Response("Not Found", { status: 404 });

  // Per-IP cap on the token endpoint: damps code/refresh-token guessing and
  // grant abuse. Generous enough for legitimate refresh traffic.
  if (!(await rateLimit(clientIpKey(request, "oauth_token"), 30, 60_000))) {
    return json(
      { error: "too_many_requests", error_description: "rate limit exceeded; try again later" },
      { status: 429, headers: TOKEN_HEADERS },
    );
  }

  const form = await request.formData();
  const grant_type = String(form.get("grant_type") ?? "");

  if (!grant_type) {
    return json({ error: "invalid_request", error_description: "grant_type is required" }, { status: 400 });
  }

  try {
    if (grant_type === "authorization_code") {
      const code = String(form.get("code") ?? "");
      const code_verifier = String(form.get("code_verifier") ?? "");
      const redirect_uri = String(form.get("redirect_uri") ?? "");
      const client_id = String(form.get("client_id") ?? "");

      if (!code || !code_verifier || !redirect_uri || !client_id) {
        return json({ error: "invalid_request", error_description: "code, code_verifier, redirect_uri, and client_id are all required" }, { status: 400 });
      }

      const client = await getClient(client_id);
      if (!client) {
        return json({ error: "invalid_client", error_description: "unknown client_id" }, { status: 401 });
      }

      const ctx = await consumeAuthCode({
        raw_code: code,
        code_verifier,
        redirect_uri,
        client_id,
      });

      const out = await mintAccessToken({
        client_id,
        client_name: client.client_name,
        shop_id: ctx.shop_id,
        scopes: ctx.scopes,
      });

      return json(out, { status: 200, headers: TOKEN_HEADERS });
    }

    if (grant_type === "refresh_token") {
      const refresh_token = String(form.get("refresh_token") ?? "");
      const client_id = String(form.get("client_id") ?? "");

      if (!refresh_token || !client_id) {
        return json({ error: "invalid_request", error_description: "refresh_token and client_id are required" }, { status: 400 });
      }

      const out = await rotateRefreshToken({ refresh_token, client_id });
      return json(out, { status: 200, headers: TOKEN_HEADERS });
    }

    return json({ error: "unsupported_grant_type", error_description: `grant_type '${grant_type}' is not supported` }, { status: 400 });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    const error = err.code === "invalid_grant" ? "invalid_grant" : "invalid_request";
    return json({ error, error_description: err.message ?? "" }, { status: 400 });
  }
};

// GET / other methods → 405
export const loader = () => new Response("Method Not Allowed", { status: 405 });
