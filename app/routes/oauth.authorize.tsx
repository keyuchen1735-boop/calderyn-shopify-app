// app/routes/oauth.authorize.tsx
//
// OAuth 2.1 authorize endpoint for the Claude.ai MCP connector.
//
// This endpoint NO LONGER pre-seeds any consumable state. It validates the
// OAuth request, mints a signed pending JWT carrying the request context, and
// renders an interstitial that deep-links the merchant into the embedded,
// authenticated consent route (/app/connect?t=<jwt>). Consent + code issuance
// happen there, bound to the merchant's authenticated session shop — which is
// what closes the pre-seed High. No DB row, no cookie, no /app auto-route.
import { useMemo } from "react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  AppProvider as PolarisAppProvider,
  BlockStack,
  Button,
  Card,
  Page,
  Text,
} from "@shopify/polaris";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import polarisTranslations from "@shopify/polaris/locales/en.json";
import { getClient, signPendingOauth } from "~/lib/mcp_oauth.server";
import { buildAppConnectUrl, SHOP_RE } from "~/lib/connect-deeplink";
import { readShopHintCookie } from "~/lib/connect-deeplink.server";

const FLAG_ON = () => process.env.MCP_OAUTH_ENABLED === "true";

interface AuthorizeParams {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string;
  state: string;
  shop?: string;
}

function readParams(url: URL): AuthorizeParams {
  const p = (k: string) => url.searchParams.get(k) ?? "";
  return {
    response_type: p("response_type"),
    client_id: p("client_id"),
    redirect_uri: p("redirect_uri"),
    code_challenge: p("code_challenge"),
    code_challenge_method: p("code_challenge_method") || "S256",
    scope: p("scope") || "read",
    state: p("state"),
    shop: url.searchParams.get("shop") ?? undefined,
  };
}

function redirectError(
  params: AuthorizeParams,
  code: "invalid_request" | "unsupported_response_type",
  detail: string,
): Response {
  const url = new URL(params.redirect_uri);
  url.searchParams.set("error", code);
  url.searchParams.set("error_description", detail);
  if (params.state) url.searchParams.set("state", params.state);
  return redirect(url.toString(), 302);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!FLAG_ON()) return new Response("Not Found", { status: 404 });

  const url = new URL(request.url);
  const params = readParams(url);

  // Before we can safely redirect to redirect_uri with an error, we must validate
  // client_id + redirect_uri. Other errors get redirected per OAuth spec.
  if (
    !params.response_type ||
    !params.client_id ||
    !params.redirect_uri ||
    !params.code_challenge ||
    !params.state
  ) {
    return new Response("invalid_request: missing required parameter", { status: 400 });
  }

  const client = await getClient(params.client_id);
  if (!client) return new Response("invalid_request: unknown client_id", { status: 400 });
  if (!client.redirect_uris.includes(params.redirect_uri)) {
    return new Response("invalid_request: redirect_uri not registered", { status: 400 });
  }

  // From here on, redirect_uri is safe to redirect to.
  if (params.response_type !== "code") {
    return redirectError(params, "unsupported_response_type", "only 'code' is supported");
  }
  if (params.code_challenge_method !== "S256") {
    return redirectError(params, "invalid_request", "code_challenge_method must be S256");
  }
  if (params.scope && params.scope.split(" ").some((s) => s !== "read")) {
    return redirectError(params, "invalid_request", "only scope=read is supported in v1");
  }

  // Mint the signed pending JWT. It carries the OAuth request context across the
  // embedded token-exchange (URL params survive even when the SameSite=None
  // cookie dies across Vercel-alias domains). It carries NO shop — the consent
  // routes ALWAYS issue against the authenticated session shop. The `?shop=`
  // hint below is used only to build a nicer deep link, never put in the token.
  const shopHint = url.searchParams.get("shop")?.toLowerCase();
  const hintShop = shopHint && SHOP_RE.test(shopHint) ? shopHint : null;
  // Fall back to the remembered shop (written by /oauth/login on this same
  // origin). READ ONLY: /oauth/authorize must never Set-Cookie — that no-pre-seed
  // rule is the PR #107 invariant.
  const validShop = hintShop ?? readShopHintCookie(request);
  const jwt = await signPendingOauth({
    client_id: params.client_id,
    redirect_uri: params.redirect_uri,
    code_challenge: params.code_challenge,
    scope: params.scope,
    state: params.state,
  });

  return json({
    client_name: client.client_name,
    token: jwt,
    apiKey: process.env.SHOPIFY_API_KEY ?? "",
    appUrl: process.env.SHOPIFY_APP_URL ?? "",
    dashboardUrl: process.env.DASHBOARD_PUBLIC_URL ?? "https://calderyncompany.com",
    shop: validShop,
  });
};

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

type InterstitialData = {
  client_name: string;
  token: string;
  apiKey: string;
  appUrl: string;
  dashboardUrl: string;
  shop: string | null;
};

export default function AuthorizeInterstitial() {
  const data = useLoaderData<typeof loader>() as InterstitialData;

  const knownShop = data.shop;
  const directUrl = useMemo(
    () => buildAppConnectUrl({ shop: knownShop, apiKey: data.apiKey, appUrl: data.appUrl, token: data.token }),
    [data, knownShop],
  );
  const loginUrl = `${data.appUrl}/oauth/login?t=${encodeURIComponent(data.token)}`;
  const dashboardUrl = `${data.dashboardUrl}/dashboard/connect?t=${encodeURIComponent(data.token)}`;

  const go = (target: string) => {
    try {
      if (typeof window !== "undefined" && window.top) {
        window.top.location.href = target;
        return;
      }
    } catch {
      // top-window navigation may be blocked; fall through to same-window.
    }
    window.location.href = target;
  };

  return (
    <PolarisAppProvider i18n={polarisTranslations}>
      <Page title="Connect Claude.ai">
        <Card>
          <BlockStack gap="400">
            <Text as="p" variant="bodyMd">
              <b>{data.client_name}</b> wants to connect to your Calderyn data. Approve this from
              inside your Shopify admin, where we can confirm it&apos;s really you.
            </Text>
            {knownShop ? (
              <Button variant="primary" onClick={() => go(directUrl)}>
                Open Calderyn in your Shopify admin to approve
              </Button>
            ) : (
              <Button variant="primary" url={loginUrl}>
                Log in with Shopify
              </Button>
            )}
            <Text as="p" variant="bodySm" tone="subdued">
              Prefer the web dashboard?{" "}
              <Button variant="plain" onClick={() => go(dashboardUrl)}>
                Approve in the Calderyn dashboard
              </Button>
            </Text>
          </BlockStack>
        </Card>
      </Page>
    </PolarisAppProvider>
  );
}
