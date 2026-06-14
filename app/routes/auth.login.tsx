import { useState } from "react";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const errors = loginErrorMessage(await login(request));
  return json({ errors, polarisTranslations });
};

export const action = async ({ request }: ActionFunctionArgs) => {
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
