import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { CalderynError, calderynClient } from "~/lib/calderyn.server";
import { minimizeOrderWebhook } from "~/lib/ingest/mappers.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  try {
    // Store only the order fields the pipeline uses — never the customer PII
    // (name/email/phone/addresses) Shopify includes on this webhook.
    const minimal = minimizeOrderWebhook(payload as Record<string, unknown>);
    await calderynClient(shop).internal.forwardWebhook(
      "/internal/webhooks/shopify/orders_create",
      minimal,
      { "X-Shopify-Topic": topic },
    );
  } catch (err) {
    if (err instanceof CalderynError) {
      console.error(`Failed to forward orders/create for ${shop}: ${err.code} ${err.message}`);
    } else {
      console.error(`Failed to forward orders/create for ${shop}`, err);
    }
  }
  return new Response();
};
