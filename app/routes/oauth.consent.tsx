// app/routes/oauth.consent.tsx
import { useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  getClient,
  issueAuthCode,
  getPendingOauth,
  deletePendingOauth,
  verifyConsentAuth,
} from "~/lib/mcp_oauth.server";
import { resolveShopId } from "~/lib/supabase.server";

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  AppProvider as PolarisAppProvider,
  Banner,
  BlockStack,
  Button,
  ButtonGroup,
  Card,
  Page,
  Text,
} from "@shopify/polaris";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import polarisTranslations from "@shopify/polaris/locales/en.json";

async function shopFromAuth(authToken: string | null): Promise<string | null> {
  if (!authToken) return null;
  try {
    const { shop } = await verifyConsentAuth(authToken);
    return shop;
  } catch {
    return null;
  }
}

const FLAG_ON = () => process.env.MCP_OAUTH_ENABLED === "true";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!FLAG_ON()) return new Response("Not Found", { status: 404 });

  const url = new URL(request.url);
  const authToken = url.searchParams.get("_auth");
  const shop = await shopFromAuth(authToken);
  if (!shop || !authToken) return redirect("/app");

  const pendingRow = await getPendingOauth(shop);
  if (!pendingRow) return redirect("/app");

  const client = await getClient(pendingRow.client_id);
  if (!client) return redirect("/app");

  return json({
    client_name: client.client_name,
    client_id: client.client_id,
    shop,
    scopes: pendingRow.scope.split(" ").filter(Boolean),
    auth_token: authToken,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!FLAG_ON()) return new Response("Not Found", { status: 404 });

  const form = await request.formData();
  const authToken = String(form.get("_auth") ?? "");
  const shop = await shopFromAuth(authToken);
  if (!shop) return redirect("/app");

  const pendingRow = await getPendingOauth(shop);
  if (!pendingRow) return redirect("/app");

  const intent = String(form.get("intent") ?? "");

  // Return JSON (not 302) so the client-side fetcher can navigate the TOP
  // window (the popup) — a server 302 only navigates the iframe, and Claude.ai's
  // callback page expects to load in the popup with window.opener set.

  if (intent === "deny") {
    const url = new URL(pendingRow.redirect_uri);
    url.searchParams.set("error", "access_denied");
    url.searchParams.set("error_description", "merchant denied authorization");
    if (pendingRow.client_state) url.searchParams.set("state", pendingRow.client_state);
    await deletePendingOauth(shop);
    return json({ redirect_url: url.toString() });
  }

  if (intent !== "allow") return json({ error: "invalid_intent" }, { status: 400 });

  const shop_id = await resolveShopId(shop);
  const code = await issueAuthCode({
    client_id: pendingRow.client_id,
    shop_id,
    redirect_uri: pendingRow.redirect_uri,
    code_challenge: pendingRow.code_challenge,
    scopes: pendingRow.scope.split(" ").filter(Boolean),
    state: pendingRow.client_state,
  });

  const url = new URL(pendingRow.redirect_uri);
  url.searchParams.set("code", code);
  if (pendingRow.client_state) url.searchParams.set("state", pendingRow.client_state);
  await deletePendingOauth(shop);
  return json({ redirect_url: url.toString() });
};

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export default function Consent() {
  const { client_name, shop, scopes, auth_token } = useLoaderData<typeof loader>() as {
    client_name: string;
    shop: string;
    scopes: string[];
    auth_token: string;
  };
  const fetcher = useFetcher<{ redirect_url?: string; error?: string }>();
  const submitting = fetcher.state !== "idle";

  // The action returns JSON with redirect_url. We must navigate the TOP window
  // (not the iframe) so Claude.ai's callback page loads in the popup with a
  // valid window.opener.
  useEffect(() => {
    const url = fetcher.data?.redirect_url;
    if (!url) return;
    try {
      if (typeof window !== "undefined" && window.top) {
        window.top.location.href = url;
        return;
      }
    } catch {
      // top-window navigation may be blocked; fall through to same-window.
    }
    window.location.href = url;
  }, [fetcher.data]);

  const submit = (intent: "allow" | "deny") =>
    fetcher.submit(
      { intent, _auth: auth_token },
      { method: "post", action: "/oauth/consent" },
    );

  return (
    <PolarisAppProvider i18n={polarisTranslations}>
      <Page title={`Connect ${client_name} to Calderyn`}>
        <Card>
          <BlockStack gap="400">
            <Text as="p" variant="bodyMd">
              <b>{client_name}</b> is requesting access to your Calderyn data for <b>{shop}</b>.
            </Text>
            <Text as="p" variant="bodyMd">
              Permissions requested:
            </Text>
            <Text as="p" variant="bodyMd">
              {scopes.includes("read") &&
                "• Read your alerts, audit log, campaigns, SKUs, guardrails, and integration status."}
            </Text>
            <Banner tone="info">
              <p>
                You can disconnect this at any time from <b>Settings &rarr; Claude connections</b>.
              </p>
            </Banner>
            <ButtonGroup>
              <Button
                variant="primary"
                onClick={() => submit("allow")}
                loading={submitting}
                disabled={submitting}
              >
                Allow
              </Button>
              <Button
                onClick={() => submit("deny")}
                loading={submitting}
                disabled={submitting}
              >
                Deny
              </Button>
            </ButtonGroup>
          </BlockStack>
        </Card>
      </Page>
    </PolarisAppProvider>
  );
}
