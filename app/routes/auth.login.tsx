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
import { login } from "../shopify.server";
import { loginErrorMessage } from "./auth.error.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

const APP_PATH_RE = /^\/app(?:\/|$)/;

function hasEmbeddedContext(search: URLSearchParams): boolean {
  return search.has("host") || search.get("embedded") === "1";
}

function hasShopContext(search: URLSearchParams): boolean {
  return search.has("shop") || hasEmbeddedContext(search);
}

function sameOriginAppReferer(request: Request, url: URL): URL | null {
  const raw = request.headers.get("referer");
  if (!raw) return null;
  try {
    const referer = new URL(raw);
    if (referer.origin !== url.origin) return null;
    return APP_PATH_RE.test(referer.pathname) ? referer : null;
  } catch {
    return null;
  }
}

function pathAndSearch(url: URL): string {
  return `${url.pathname}${url.search}`;
}

function embeddedAppRedirectTarget(request: Request): string | null {
  const url = new URL(request.url);
  const referer = sameOriginAppReferer(request, url);
  const currentIsEmbedded = hasEmbeddedContext(url.searchParams);

  // If Shopify/App Bridge drops us on the standalone login route while the
  // merchant is already inside /app, do not render the manual shop form in the
  // iframe. Re-enter the app with its shop/host params so embedded auth can
  // recover the session token.
  if (referer && (hasShopContext(referer.searchParams) || currentIsEmbedded)) {
    const target = new URL(`${referer.pathname}${referer.search}`, url.origin);
    for (const key of ["shop", "host"] as const) {
      if (!target.searchParams.has(key) && url.searchParams.has(key)) {
        target.searchParams.set(key, url.searchParams.get(key) || "");
      }
    }
    if (hasShopContext(target.searchParams) && !target.searchParams.has("embedded")) {
      target.searchParams.set("embedded", "1");
    }
    return hasShopContext(target.searchParams) ? pathAndSearch(target) : null;
  }

  if (!currentIsEmbedded) return null;
  const target = new URL("/app", url.origin);
  for (const key of ["shop", "host", "embedded"] as const) {
    const value = url.searchParams.get(key);
    if (value) target.searchParams.set(key, value);
  }
  if (hasShopContext(target.searchParams) && !target.searchParams.has("embedded")) {
    target.searchParams.set("embedded", "1");
  }
  return hasShopContext(target.searchParams) ? pathAndSearch(target) : null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const embeddedTarget = embeddedAppRedirectTarget(request);
  if (embeddedTarget) throw redirect(embeddedTarget);

  const errors = loginErrorMessage(await login(request));
  return json({ errors, polarisTranslations });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const embeddedTarget = embeddedAppRedirectTarget(request);
  if (embeddedTarget) throw redirect(embeddedTarget);

  const errors = loginErrorMessage(await login(request));
  return json({ errors });
};

export default function Auth() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [shop, setShop] = useState("");
  const { errors } = actionData || loaderData;

  return (
    <PolarisAppProvider i18n={loaderData.polarisTranslations}>
      <Page narrowWidth>
        <Card>
          <BlockStack gap="400">
            <BlockStack gap="100">
              <Text variant="headingLg" as="h1">
                Calderyn
              </Text>
              <Text as="p" tone="subdued">
                The AI ops copilot for your Shopify store — watching ad spend and inventory
                together, and flagging money leaks before they compound.
              </Text>
            </BlockStack>
            <Form method="post">
              <FormLayout>
                <TextField
                  type="text"
                  name="shop"
                  label="Shop domain"
                  helpText="Enter your store to open Calderyn in your Shopify admin (example.myshopify.com)."
                  value={shop}
                  onChange={setShop}
                  autoComplete="on"
                  error={"shop" in errors ? errors.shop : undefined}
                />
                <Button submit variant="primary">
                  Log in
                </Button>
              </FormLayout>
            </Form>
          </BlockStack>
        </Card>
      </Page>
    </PolarisAppProvider>
  );
}
