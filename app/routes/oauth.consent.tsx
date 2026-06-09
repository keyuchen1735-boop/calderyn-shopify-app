// app/routes/oauth.consent.tsx
import { useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  PENDING_COOKIE_NAME,
  verifyPendingOauth,
  getClient,
  issueAuthCode,
  getPendingOauth,
  deletePendingOauth,
  type PendingOauthRow,
} from "~/lib/mcp_oauth.server";
import { resolveShopId } from "~/lib/supabase.server";
import { authenticate } from "../shopify.server";

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

interface PendingCtx {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  state: string;
}

async function loadPendingCtx(
  request: Request,
  shop: string,
): Promise<PendingCtx | null> {
  // Authoritative path: server-side row keyed by shop.
  const row: PendingOauthRow | null = await getPendingOauth(shop);
  if (row) {
    return {
      client_id: row.client_id,
      redirect_uri: row.redirect_uri,
      code_challenge: row.code_challenge,
      scope: row.scope,
      state: row.client_state,
    };
  }
  // Fallback: signed cookie (works only when /app loads on the same domain
  // as /oauth/authorize, which is not the embedded-admin case in prod).
  const h = request.headers.get("cookie") ?? "";
  const m = h.match(new RegExp(`${PENDING_COOKIE_NAME}=([^;]+)`));
  if (!m) return null;
  try {
    const cookieCtx = await verifyPendingOauth(m[1]);
    if (cookieCtx.shop !== shop) return null;
    return {
      client_id: cookieCtx.client_id,
      redirect_uri: cookieCtx.redirect_uri,
      code_challenge: cookieCtx.code_challenge,
      scope: cookieCtx.scope,
      state: cookieCtx.state,
    };
  } catch {
    return null;
  }
}

const FLAG_ON = () => process.env.MCP_OAUTH_ENABLED === "true";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!FLAG_ON()) return new Response("Not Found", { status: 404 });
  const { session } = await authenticate.admin(request);

  const ctx = await loadPendingCtx(request, session.shop);
  if (!ctx) return redirect("/app");

  const client = await getClient(ctx.client_id);
  if (!client) return redirect("/app");

  return json({
    client_name: client.client_name,
    client_id: client.client_id,
    shop: session.shop,
    scopes: ctx.scope.split(" ").filter(Boolean),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!FLAG_ON()) return new Response("Not Found", { status: 404 });
  const { session } = await authenticate.admin(request);
  const ctx = await loadPendingCtx(request, session.shop);
  if (!ctx) return redirect("/app");

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  const clearCookie = `${PENDING_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None`;

  // Return JSON (not 302) so the client-side fetcher can navigate the TOP
  // window (the popup) — a server 302 only navigates the iframe, and Claude.ai's
  // callback page expects to load in the popup with window.opener set.

  if (intent === "deny") {
    const url = new URL(ctx.redirect_uri);
    url.searchParams.set("error", "access_denied");
    url.searchParams.set("error_description", "merchant denied authorization");
    if (ctx.state) url.searchParams.set("state", ctx.state);
    await deletePendingOauth(session.shop);
    const headers = new Headers();
    headers.append("set-cookie", clearCookie);
    return json({ redirect_url: url.toString() }, { headers });
  }

  if (intent !== "allow") return json({ error: "invalid_intent" }, { status: 400 });

  const shop_id = await resolveShopId(session.shop);
  const code = await issueAuthCode({
    client_id: ctx.client_id,
    shop_id,
    redirect_uri: ctx.redirect_uri,
    code_challenge: ctx.code_challenge,
    scopes: ctx.scope.split(" ").filter(Boolean),
    state: ctx.state,
  });

  const url = new URL(ctx.redirect_uri);
  url.searchParams.set("code", code);
  if (ctx.state) url.searchParams.set("state", ctx.state);
  await deletePendingOauth(session.shop);
  const headers = new Headers();
  headers.append("set-cookie", clearCookie);
  return json({ redirect_url: url.toString() }, { headers });
};

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export default function Consent() {
  const { client_name, shop, scopes } = useLoaderData<typeof loader>() as {
    client_name: string;
    shop: string;
    scopes: string[];
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
    fetcher.submit({ intent }, { method: "post", action: "/oauth/consent" });

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
