// GET returns the integrations map; POST connects/disconnects a provider
// natively from the dashboard (no embedded-admin round-trip):
//   { intent: "connect", provider }             → { url } to the provider's consent screen
//   { intent: "connect-key", provider, apiKey } → validates + stores the pasted credential
//   { intent: "disconnect", provider }          → removes the pairing (and ship-cost credential)
// The OAuth callback returns to /dashboard?<provider>=connected|error (the
// `dashboard` flag rides the single-use state nonce — see oauth-state.server.ts).

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, rateLimit, requireSameOrigin } from "~/lib/dashboard/http.server";
import { calderynClient, type IntegrationProvider } from "~/lib/calderyn.server";
import { APIKEY_PROVIDERS, OAUTH_PROVIDERS } from "~/lib/integrations";

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  return dashboardJson(async () => ({
    integrations: await calderynClient(session.shopId).integrations.list(),
  }));
}

const isOAuth = (p: string): p is IntegrationProvider =>
  (OAUTH_PROVIDERS as readonly string[]).includes(p);
const isApiKey = (p: string): p is IntegrationProvider =>
  (APIKEY_PROVIDERS as readonly string[]).includes(p);

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");
  // connect-key live-probes merchant-supplied credentials against third-party
  // APIs — without a limit this action is a free key-validation oracle.
  if (!(await rateLimit(`integrations:${session.shopId}`, 20, 60_000))) {
    return jsonError(429, "rate_limited");
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError(422, "invalid_json");
  }
  const intent = typeof body.intent === "string" ? body.intent : "";
  const provider = typeof body.provider === "string" ? body.provider : "";
  const client = calderynClient(session.shopId);

  if (intent === "connect") {
    if (!isOAuth(provider)) return jsonError(422, "invalid_provider");
    return dashboardJson(async () => {
      const { redirectUrl } = await client.integrations.startOAuth(
        provider,
        null,
        false,
        /* dashboard */ true,
      );
      return { url: redirectUrl };
    });
  }

  if (intent === "connect-key") {
    if (!isApiKey(provider)) return jsonError(422, "invalid_provider");
    // Reject a missing/blank credential at the boundary rather than coercing
    // it to "" and relying on the downstream probe to fail it.
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    if (!apiKey) return jsonError(422, "empty_api_key");
    return dashboardJson(async () => {
      // connectApiKey live-probes the key and fails visibly before writing.
      await client.integrations.connectApiKey(provider, apiKey);
      return { integrations: await client.integrations.list() };
    });
  }

  if (intent === "disconnect") {
    if (!isOAuth(provider) && !isApiKey(provider)) return jsonError(422, "invalid_provider");
    return dashboardJson(async () => {
      await client.integrations.disconnect(provider);
      return { integrations: await client.integrations.list() };
    });
  }

  return jsonError(422, "unknown_intent");
}
