// app/routes/oauth.login.tsx
//
// Cold-path "Log in with Shopify" page for the Claude.ai MCP connector.
//
// Reached from the /oauth/authorize interstitial when we don't yet know the
// merchant's shop (no ?shop= hint, no __Host-cala_shop cookie). The merchant
// enters their *.myshopify.com domain once; we remember it (cookie, same host as
// /oauth/authorize) and hand off to the embedded /app/connect consent screen via
// the admin.shopify.com deep link, which carries the signed pending token (?t=)
// through Shopify's own login. NO Shopify OAuth round-trip happens here — we only
// capture the shop and build the deep link. The shop is never put in the token;
// /app/connect still issues the code against its authenticated session shop.
import { useState } from "react";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  AppProvider as PolarisAppProvider,
  BlockStack,
  Button,
  Card,
  FormLayout,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import polarisTranslations from "@shopify/polaris/locales/en.json";
import { getClient, verifyPendingOauth } from "~/lib/mcp_oauth.server";
import { buildAppConnectUrl, SHOP_RE } from "~/lib/connect-deeplink";
import { shopHintCookieHeader } from "~/lib/connect-deeplink.server";

const FLAG_ON = () => process.env.MCP_OAUTH_ENABLED === "true";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!FLAG_ON()) return new Response("Not Found", { status: 404 });
  const appUrl = process.env.SHOPIFY_APP_URL ?? "";
  const token = new URL(request.url).searchParams.get("t") ?? "";
  let ctx;
  try {
    ctx = await verifyPendingOauth(token);
  } catch {
    return redirect(`${appUrl}/app`);
  }
  const client = await getClient(ctx.client_id);
  if (!client) return redirect(`${appUrl}/app`);
  return json({ token, client_name: client.client_name, polarisTranslations });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!FLAG_ON()) return new Response("Not Found", { status: 404 });
  const appUrl = process.env.SHOPIFY_APP_URL ?? "";
  const apiKey = process.env.SHOPIFY_API_KEY ?? "";

  const form = await request.formData();
  const token = String(form.get("t") ?? "");
  const shop = String(form.get("shop") ?? "").trim().toLowerCase();

  // The token must still be a valid pending-OAuth JWT, else this isn't a real
  // connector flow.
  try {
    await verifyPendingOauth(token);
  } catch {
    return json({ error: "invalid_token" }, { status: 400 });
  }

  if (!SHOP_RE.test(shop)) {
    return json({ error: "invalid_shop", token }, { status: 422 });
  }

  return redirect(buildAppConnectUrl({ shop, apiKey, appUrl, token }), {
    headers: { "Set-Cookie": shopHintCookieHeader(shop) },
  });
};

type LoaderData = {
  token: string;
  client_name: string;
  polarisTranslations: typeof polarisTranslations;
};

export default function OauthLogin() {
  const { token, client_name, polarisTranslations: i18n } = useLoaderData<typeof loader>() as LoaderData;
  const actionData = useActionData<typeof action>() as { error?: string } | undefined;
  const [shop, setShop] = useState("");

  const error =
    actionData?.error === "invalid_shop"
      ? "Enter your store as example.myshopify.com"
      : actionData?.error === "invalid_token"
        ? "This connection request expired. Start again from Claude."
        : undefined;

  return (
    <PolarisAppProvider i18n={i18n}>
      <Page narrowWidth>
        <Card>
          <BlockStack gap="400">
            <BlockStack gap="100">
              <Text variant="headingLg" as="h1">
                Connect {client_name} to Calderyn
              </Text>
              <Text as="p" tone="subdued">
                Enter your Shopify store to approve this connection in your admin.
              </Text>
            </BlockStack>
            <Form method="post">
              <input type="hidden" name="t" value={token} />
              <FormLayout>
                <TextField
                  type="text"
                  name="shop"
                  label="Store domain"
                  helpText="example.myshopify.com"
                  value={shop}
                  onChange={setShop}
                  autoComplete="on"
                  error={error}
                />
                <Button
                  submit
                  variant="primary"
                  disabled={!SHOP_RE.test(shop.trim().toLowerCase())}
                >
                  Log in with Shopify
                </Button>
              </FormLayout>
            </Form>
          </BlockStack>
        </Card>
      </Page>
    </PolarisAppProvider>
  );
}
