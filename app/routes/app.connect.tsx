// app/routes/app.connect.tsx
//
// Embedded, authenticated consent screen for the Claude.ai MCP connector.
//
// This route closes the OAuth pre-seed High. The merchant approves *inside* the
// Shopify admin, where authenticate.admin establishes the shop server-side. The
// unguessable carrier is the signed pending JWT (`?t=`) minted by
// /oauth/authorize — URL params survive the embedded token-exchange even when
// the SameSite=None cookie dies across Vercel-alias domains.
//
// SECURITY INVARIANT: the code is issued for `session.shop` (from
// authenticate.admin), NOT for any `shop` field inside the token. A merchant
// can only ever consent for their own shop, so an attacker who knows the OAuth
// request params still cannot get a code minted for a victim's shop.
import { useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
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
import { authenticate } from "../shopify.server";
import {
  buildAuthCodeRedirect,
  buildDenyRedirect,
  destinationHost,
  getClient,
  issueAuthCode,
  verifyPendingOauth,
} from "~/lib/mcp_oauth.server";
import { resolveShopId } from "~/lib/supabase.server";

const FLAG_ON = () => process.env.MCP_OAUTH_ENABLED === "true";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!FLAG_ON()) return new Response("Not Found", { status: 404 });

  // Establishes the embedded session; gates the page to an authenticated merchant.
  await authenticate.admin(request);

  const url = new URL(request.url);
  const token = url.searchParams.get("t") ?? "";

  let ctx;
  try {
    ctx = await verifyPendingOauth(token);
  } catch {
    return redirect("/app");
  }

  const client = await getClient(ctx.client_id);
  if (!client) return redirect("/app");

  return json({
    token,
    client_name: client.client_name,
    destinationHost: destinationHost(ctx.redirect_uri),
    scopes: ctx.scope.split(" ").filter(Boolean),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!FLAG_ON()) return new Response("Not Found", { status: 404 });

  const { session } = await authenticate.admin(request);

  const form = await request.formData();
  const token = String(form.get("t") ?? "");
  const intent = String(form.get("intent") ?? "");

  let ctx;
  try {
    ctx = await verifyPendingOauth(token);
  } catch {
    return json({ error: "invalid_token" }, { status: 400 });
  }

  // Return JSON (not 302) so the client navigates the TOP window (the OAuth
  // popup) — a server 302 only moves the embedded iframe, and Claude.ai's
  // callback page expects to load in the popup with a valid window.opener.
  if (intent === "deny") {
    return json({ redirect_url: buildDenyRedirect(ctx.redirect_uri, ctx.state) });
  }

  if (intent !== "allow") return json({ error: "invalid_intent" }, { status: 400 });

  // The crux of the fix: bind issuance to the authenticated session's shop.
  const shop_id = await resolveShopId(session.shop);
  const code = await issueAuthCode({
    client_id: ctx.client_id,
    shop_id,
    redirect_uri: ctx.redirect_uri,
    code_challenge: ctx.code_challenge,
    scopes: ctx.scope.split(" ").filter(Boolean),
    state: ctx.state,
  });

  return json({ redirect_url: buildAuthCodeRedirect(ctx.redirect_uri, code, ctx.state) });
};

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export default function Connect() {
  const { token, client_name, destinationHost, scopes } = useLoaderData<typeof loader>() as {
    token: string;
    client_name: string;
    destinationHost: string;
    scopes: string[];
  };

  const fetcher = useFetcher<{ redirect_url?: string; error?: string }>();
  const submitting = fetcher.state !== "idle";

  // Navigate the TOP window (not the iframe) so Claude.ai's callback page loads
  // in the popup with a valid window.opener.
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
    fetcher.submit({ intent, t: token }, { method: "post", action: "/app/connect" });

  return (
    <PolarisAppProvider i18n={polarisTranslations}>
      <Page title={`Connect ${client_name} to Calderyn`}>
        <Card>
          <BlockStack gap="400">
            <Text as="p" variant="bodyMd">
              <b>{client_name}</b> is requesting read-only access to your Calderyn data.
            </Text>
            <Text as="p" variant="bodyMd">
              Data will be sent to: <b>{destinationHost}</b>
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
              <Button onClick={() => submit("deny")} loading={submitting} disabled={submitting}>
                Deny
              </Button>
            </ButtonGroup>
          </BlockStack>
        </Card>
      </Page>
    </PolarisAppProvider>
  );
}
